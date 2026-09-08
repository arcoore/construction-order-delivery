-- Self-service account deletion that actually works for a real account.
--
-- THE PROBLEM THIS FIXES
-- ----------------------
-- supabase/functions/delete-account only ever hard-deleted the auth.users
-- row. profiles.id references auth.users ON DELETE CASCADE, and ~30 other
-- FKs reference profiles(id) with NO cascade (orders.requested_by_id,
-- community_memberships.user_id, notifications.recipient_user_id, …). So the
-- moment an account joined a company or received a notification, deleting it
-- was blocked by a foreign-key violation and the user got "contact support".
-- That is not a working right to erasure.
--
-- THE DESIGN (founder decision, 2026-09-08)
-- ----------------------------------------
-- "Delete everything except their name in histories and everything that goes
--  with that … so it doesn't interrupt the workflow or the company after
--  they've deleted their account."
--
-- So on deletion we:
--   * KEEP the profiles row and its display_name, and every record that
--     carries the person's name or id (orders, order_events, order_messages,
--     delivery_photos, cancellation_requests, membership/decision history).
--     A past order still reads "requested by Dave" forever.
--   * DELETE the login and everything personal-only: the auth.users row
--     (email, password hash, sessions, MFA factors — done by the Edge
--     Function's Admin API call, AFTER this function has run), the person's
--     notifications and notification preferences, their pending join /
--     buyer requests, their browser error reports, and every live permission
--     they hold (owner grants, buyer grants, site memberships).
--   * END their active memberships (status -> 'left') so they drop out of
--     every team list, with an audit event and the usual "a member left"
--     notification to owners.
--   * BLOCK the whole thing if they still CREATED a company they own — they
--     must transfer it (Team panel) or delete it (owner dashboard) first.
--     Matches leave_community's "the creator cannot leave" rule.
--
-- WHY profiles must stop cascading from auth.users
-- -----------------------------------------------
-- For the profile (and therefore the name on every historical record) to
-- survive the auth.users deletion, profiles.id can no longer be ON DELETE
-- CASCADE from auth.users. We drop that FK entirely. profiles.id stays a
-- plain uuid PK; the 0002 on_auth_user_created trigger still populates it for
-- every new signup, and nothing anywhere joins profiles back to auth.users
-- or assumes a 1:1 (every permission check reads auth.uid() from the JWT,
-- never a profiles row). client_errors.user_id (ON DELETE SET NULL) is then
-- the only remaining reference to auth.users, so the Admin API delete
-- succeeds cleanly.

-- ================================================================
-- 1. profiles: keep the row after the auth user is gone.
-- ================================================================
alter table profiles drop constraint profiles_id_fkey;

alter table profiles add column if not exists deleted_at timestamptz;

comment on column profiles.deleted_at is
  'Set by anonymize_own_account() when the person deleted their account. The '
  'row is kept (with display_name) so their name still reads correctly on '
  'their company''s historical records; the auth.users login is deleted '
  'separately by the delete-account Edge Function.';

-- ================================================================
-- 2. anonymize_own_account() — the caller scrubs their OWN account.
--
--    SECURITY DEFINER + auth.uid() guard, same shape as leave_community.
--    Called by the delete-account Edge Function with the caller's own JWT
--    forwarded, so auth.uid() is the person being deleted. The Edge Function
--    then deletes the auth.users row via the Admin API.
--
--    Idempotent: if deleted_at is already set it returns quietly, so the
--    Edge Function can safely retry the Admin API step after a transient
--    failure.
-- ================================================================
create or replace function anonymize_own_account()
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_name text;
  v_owned int;
  v_m record;
begin
  if v_uid is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  -- Already done (an Edge Function retry) — no-op, let the caller proceed.
  if exists (select 1 from profiles where id = v_uid and deleted_at is not null) then
    return;
  end if;

  -- Block: a company you CREATED must be handed over or deleted first.
  select count(*) into v_owned from communities where owner_id = v_uid;
  if v_owned > 0 then
    raise exception
      'You still own % compan%. Transfer ownership to another owner, or delete the company, before deleting your account.',
      v_owned, case when v_owned = 1 then 'y' else 'ies' end
      using errcode = '42501';
  end if;

  -- Lock the profile row for the duration.
  perform 1 from profiles where id = v_uid for update;

  v_name := coalesce(nullif(_current_display_name(), ''), 'A member');

  -- End every active membership: audit event + owner notification + 'left'.
  for v_m in
    select id, community_id, status
    from community_memberships
    where user_id = v_uid and status in ('approved', 'suspended')
    for update
  loop
    perform _log_membership_event(
      v_m.id, v_m.community_id, 'member_left', v_m.status, 'left', 'Account deleted', null
    );

    insert into notifications
      (recipient_user_id, type, category, title, message, community_id, actor_id, actor_name, navigation_target)
    select
      o.uid, 'member_left', 'roleUpdates', 'A member left',
      format('%s deleted their SiteStock account.', v_name),
      v_m.community_id, v_uid, v_name,
      jsonb_build_object('communityId', v_m.community_id, 'role', 'owner')
    from (
      select owner_id as uid from communities where id = v_m.community_id
      union
      select user_id from owner_grants where community_id = v_m.community_id
    ) o
    where o.uid is distinct from v_uid
      and notification_type_enabled_for(o.uid, 'member_left');

    update community_memberships set
      status = 'left',
      status_changed_at = now(),
      status_changed_by_id = v_uid,
      status_reason = 'Account deleted'
    where id = v_m.id;
  end loop;

  -- A still-pending join request just goes away (no history worth keeping).
  delete from community_memberships where user_id = v_uid and status = 'pending';

  -- Live permissions — gone.
  delete from owner_grants     where user_id = v_uid;
  delete from buyer_grants     where user_id = v_uid;
  delete from site_memberships where user_id = v_uid;
  delete from buyer_requests   where user_id = v_uid;

  -- Personal-only data — gone.
  delete from notifications            where recipient_user_id = v_uid;
  delete from notification_preferences where user_id = v_uid;
  delete from client_errors            where user_id = v_uid;

  -- Keep the profile + display_name; just mark it and record when.
  update profiles set deleted_at = now() where id = v_uid;
end;
$$;

revoke execute on function anonymize_own_account() from public, anon;
grant execute on function anonymize_own_account() to authenticated;
