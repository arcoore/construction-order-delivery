-- Company Workforce Lifecycle — Phase B (data layer only, no UI).
--
-- Adds the member lifecycle the handoff (§9/§21) always wanted and never
-- had: an owner can suspend / restore / remove a member, a member can
-- leave, and a declined/left/removed person can re-request. Designed
-- against the current Supabase architecture per the approved design doc
-- (.tools/WORKFORCE_LIFECYCLE_DESIGN.md), decisions D0–D7 = "yes to all".
--
-- KEY ARCHITECTURE FACTS THIS MIGRATION RESTS ON (verified against schema):
--   * owner_grants / buyer_grants / site_memberships reference
--     profiles(id) + communities(id) DIRECTLY, never community_memberships.
--     So a status change does NOT cascade to them — remove/leave must
--     clean them up explicitly, or a removed member keeps orphaned
--     elevated access.
--   * Since 0022 there is NO client UPDATE policy on community_memberships.
--     Every transition here is a guarded SECURITY DEFINER RPC, same shape
--     and same `where status = <expected>` / 40001-on-mismatch discipline
--     as decide_join_request and every order-lifecycle RPC.
--   * is_approved_member checks status = 'approved' — suspended/removed/
--     left are all correctly excluded from it already. But
--     can_purchase_for_site did NOT gate on is_approved_member (unlike
--     can_create_order_for_site) — a latent gap suspension would expose
--     (a suspended buyer could still purchase). Fixed in section 4.
--
-- NOT in this migration (Phase C): any UI, and the realtime kick-out that
-- routes a suspended/removed member out of their role view mid-session
-- (that extends site.js's existing subscribeCommunities handler).

-- ================================================================
-- 1. community_memberships.status: enum -> text + CHECK.
--
-- WHY not `alter type membership_status add value`: Postgres won't let a
-- newly-added enum value be USED in the same transaction that adds it, and
-- Supabase runs each migration file in one transaction — so the RPCs below
-- (which write 'suspended' etc.) could not be created in this same file.
-- notifications.type already uses exactly this text+CHECK pattern for the
-- same reason (see 0022's own comment: "a real CHECK constraint … not an
-- enum"). buyer_requests.status stays on the membership_status enum,
-- untouched — it only ever holds pending/approved/declined.
--
-- Postgres refuses `alter column type` while any policy expression
-- references the column — so both policies that touch
-- community_memberships.status are dropped first and recreated after:
--   * community_memberships_insert_self_pending (0009) — its own table,
--     with check (... and status = 'pending')
--   * communities_select_scoped (0021) — a policy on `communities` whose
--     subquery reads community_memberships.status; recreated in section 3
--     below with 'suspended' added.
-- ================================================================
drop policy community_memberships_insert_self_pending on community_memberships;
drop policy communities_select_scoped on communities;

alter table community_memberships alter column status drop default;
alter table community_memberships alter column status type text using status::text;
alter table community_memberships alter column status set default 'pending';
alter table community_memberships add constraint community_memberships_status_check
  check (status in ('pending', 'approved', 'declined', 'suspended', 'removed', 'left'));

-- Recreate the insert policy verbatim (0009) — a user may only ever insert
-- their own row, and only in the pending state.
create policy community_memberships_insert_self_pending on community_memberships
  for insert to authenticated
  with check (user_id = auth.uid() and status = 'pending');

alter table community_memberships add column status_changed_at timestamptz;
alter table community_memberships add column status_changed_by_id uuid references profiles (id);
alter table community_memberships add column status_reason text;

-- ================================================================
-- 2. community_membership_events — append-only audit trail, mirrors
--    order_events exactly (RPC-write-only, no client insert/update/delete).
--    Event types: member_suspended, member_restored, member_removed,
--    member_left, member_rerequested.
-- ================================================================
create table community_membership_events (
  id uuid primary key default gen_random_uuid(),
  membership_id uuid not null references community_memberships (id) on delete cascade,
  community_id uuid not null references communities (id) on delete cascade,
  type text not null,
  actor_id uuid references profiles (id),
  actor_name text,
  from_status text,
  to_status text,
  reason text,
  meta jsonb,
  created_at timestamptz not null default now()
);
create index community_membership_events_membership_idx on community_membership_events (membership_id);
create index community_membership_events_community_idx on community_membership_events (community_id);

alter table community_membership_events enable row level security;

-- The member themself, or any owner of the community, may read the trail.
-- No self-reference risk: this queries community_memberships (a different
-- table) and is_owner queries communities/owner_grants.
create policy community_membership_events_select on community_membership_events
  for select to authenticated
  using (
    exists (
      select 1 from community_memberships m
      where m.id = community_membership_events.membership_id and m.user_id = auth.uid()
    )
    or is_owner(community_id, auth.uid())
  );

grant select on community_membership_events to authenticated;
-- deliberately NO insert/update/delete grant — RPC-only, like order_events.

-- ================================================================
-- 3. communities SELECT scoping — recreated (dropped in section 1 so the
--    column type change could proceed). Adds 'suspended' so a suspended
--    member keeps visibility of the company they're suspended from
--    (needed for any "you're suspended from X" surface; harmless —
--    is_approved_member is still false so they can't act). removed/left/
--    declined stay excluded; a re-request puts them back to 'pending'
--    which is already covered.
-- ================================================================
create policy communities_select_scoped on communities
  for select to authenticated
  using (
    discoverable = true
    or owner_id = auth.uid()
    or has_owner_grant(id, auth.uid())
    or exists (
      select 1 from community_memberships
      where community_id = communities.id
        and user_id = auth.uid()
        and status in ('approved', 'pending', 'suspended')
    )
  );

-- ================================================================
-- 4. can_purchase_for_site — close the latent gap: a buyer must also be an
--    approved community member (matching can_create_order_for_site).
--    Without this, a suspended member holding a dormant buyer grant +
--    site membership could still purchase.
-- ================================================================
create or replace function can_purchase_for_site(p_site_id uuid, p_community_id uuid, p_user_id uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from sites where id = p_site_id and community_id = p_community_id
  ) and (
    is_owner(p_community_id, p_user_id)
    or (
      is_approved_member(p_community_id, p_user_id)
      and has_buyer_grant(p_community_id, p_user_id)
      and is_site_member(p_site_id, p_user_id)
    )
  );
$$;

-- ================================================================
-- 5. notifications.type — four new values.
-- ================================================================
alter table notifications drop constraint notifications_type_check;
alter table notifications add constraint notifications_type_check check (type in (
  'order_awaiting_approval', 'order_rejected', 'approval_reverted', 'order_ready_for_purchase',
  'delivery_available', 'delivery_claimed', 'delivery_cancelled', 'delivery_collected', 'order_delivered',
  'buyer_access_requested', 'buyer_access_granted', 'buyer_access_rejected', 'buyer_access_revoked',
  'site_member_added', 'site_member_removed', 'site_archived',
  'cancellation_requested', 'cancellation_approved', 'cancellation_rejected',
  'membership_approved', 'membership_declined',
  'membership_suspended', 'membership_restored', 'membership_removed', 'member_left'
));

-- ================================================================
-- 6. notification_type_enabled_for — recreate with the four new types.
--    suspended/restored/removed are non-configurable (they change the
--    recipient's own access, like membership_approved / buyer_access_*).
--    member_left is owner-facing and doesn't change the owner's access,
--    so it follows the 'role' category like buyer_access_requested.
-- ================================================================
create or replace function notification_type_enabled_for(p_user_id uuid, p_type text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_configurable boolean := true;
  v_subcol text := null;
  v_category text := null;
  v_prefs notification_preferences%rowtype;
begin
  case p_type
    when 'order_awaiting_approval' then v_category := 'approval';
    when 'order_rejected' then v_category := 'approval';
    when 'approval_reverted' then v_category := 'approval';
    when 'order_ready_for_purchase' then v_category := 'order';
    when 'delivery_available' then v_category := 'delivery'; v_subcol := 'delivery_available_enabled';
    when 'delivery_claimed' then v_category := 'delivery'; v_subcol := 'delivery_claimed_enabled';
    when 'delivery_cancelled' then v_category := 'delivery';
    when 'delivery_collected' then v_category := 'delivery'; v_subcol := 'delivery_collected_enabled';
    when 'order_delivered' then v_category := 'delivery';
    when 'buyer_access_requested' then v_category := 'role';
    when 'buyer_access_granted' then v_configurable := false;
    when 'buyer_access_rejected' then v_category := 'role';
    when 'buyer_access_revoked' then v_configurable := false;
    when 'site_member_added' then v_configurable := false;
    when 'site_member_removed' then v_configurable := false;
    when 'site_archived' then v_configurable := false;
    when 'membership_approved' then v_configurable := false;
    when 'membership_declined' then v_configurable := false;
    when 'membership_suspended' then v_configurable := false;
    when 'membership_restored' then v_configurable := false;
    when 'membership_removed' then v_configurable := false;
    when 'member_left' then v_category := 'role';
    when 'cancellation_requested' then v_category := 'order';
    when 'cancellation_approved' then v_category := 'order';
    when 'cancellation_rejected' then v_category := 'order';
    else v_configurable := true;
  end case;

  if not v_configurable then
    return true;
  end if;

  select * into v_prefs from notification_preferences where user_id = p_user_id;
  if not found then
    return v_subcol is null;
  end if;

  if v_subcol = 'delivery_available_enabled' then return coalesce(v_prefs.delivery_available_enabled, false); end if;
  if v_subcol = 'delivery_claimed_enabled' then return coalesce(v_prefs.delivery_claimed_enabled, false); end if;
  if v_subcol = 'delivery_collected_enabled' then return coalesce(v_prefs.delivery_collected_enabled, false); end if;

  case v_category
    when 'order' then return coalesce(v_prefs.order_updates, true);
    when 'approval' then return coalesce(v_prefs.approval_updates, true);
    when 'delivery' then return coalesce(v_prefs.delivery_updates, true);
    when 'role' then return coalesce(v_prefs.role_updates, true);
    else return true;
  end case;
end;
$$;

-- ================================================================
-- 7. Shared internal helper — append a membership event. Not security-
--    gated itself (SECURITY DEFINER, only ever called from the RPCs
--    below, never granted to anyone).
-- ================================================================
create or replace function _log_membership_event(
  p_membership_id uuid, p_community_id uuid, p_type text,
  p_from text, p_to text, p_reason text, p_meta jsonb
)
returns void
language sql security definer set search_path = public as $$
  insert into community_membership_events
    (membership_id, community_id, type, actor_id, actor_name, from_status, to_status, reason, meta)
  values (
    p_membership_id, p_community_id, p_type, auth.uid(),
    coalesce(nullif(_current_display_name(), ''), 'An owner'),
    p_from, p_to, p_reason, p_meta
  );
$$;
revoke execute on function _log_membership_event(uuid, uuid, text, text, text, text, jsonb) from public, anon, authenticated;

-- ================================================================
-- 8a. suspend_member — approved -> suspended. Any owner; creator only if
--     the target is themselves an owner. Never the creator; never self.
--     Grants + site memberships are LEFT IN PLACE (dormant) — restore is
--     a true one-click undo.
-- ================================================================
create or replace function suspend_member(p_membership_id uuid, p_reason text default null)
returns community_memberships
language plpgsql security definer set search_path = public as $$
declare
  v_m community_memberships%rowtype;
  v_target_is_owner boolean;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;

  select * into v_m from community_memberships where id = p_membership_id for update;
  if not found then raise exception 'membership not found' using errcode = '42704'; end if;

  if not is_owner(v_m.community_id, auth.uid()) then
    raise exception 'only an owner may suspend a member' using errcode = '42501';
  end if;
  if v_m.user_id = auth.uid() then
    raise exception 'you cannot suspend yourself' using errcode = '42501';
  end if;
  if is_creator(v_m.community_id, v_m.user_id) then
    raise exception 'the company creator cannot be suspended' using errcode = '42501';
  end if;
  v_target_is_owner := has_owner_grant(v_m.community_id, v_m.user_id);
  if v_target_is_owner and not is_creator(v_m.community_id, auth.uid()) then
    raise exception 'only the company creator may suspend another owner' using errcode = '42501';
  end if;

  update community_memberships set
    status = 'suspended',
    status_changed_at = now(),
    status_changed_by_id = auth.uid(),
    status_reason = p_reason
  where id = p_membership_id and status = 'approved'
  returning * into v_m;
  if not found then raise exception 'member is not in an approved state' using errcode = '40001'; end if;

  perform _log_membership_event(v_m.id, v_m.community_id, 'member_suspended', 'approved', 'suspended', p_reason, null);

  insert into notifications (recipient_user_id, type, category, title, message, community_id, actor_id, actor_name, navigation_target)
  select v_m.user_id, 'membership_suspended', 'roleUpdates', 'Access suspended',
    format('Your access to %s has been suspended.', (select name from communities where id = v_m.community_id)),
    v_m.community_id, auth.uid(), coalesce(nullif(_current_display_name(), ''), 'An owner'),
    jsonb_build_object('communityId', v_m.community_id, 'view', 'profile')
  where v_m.user_id is distinct from auth.uid();

  return v_m;
end;
$$;

-- ================================================================
-- 8b. restore_member — suspended|removed -> approved. Any owner.
--     For a previously-removed member their grants/sites were stripped,
--     so restore = "a member again", re-grant separately (same as a
--     fresh approval). For a suspended member the dormant grants/sites
--     become live again automatically.
-- ================================================================
create or replace function restore_member(p_membership_id uuid)
returns community_memberships
language plpgsql security definer set search_path = public as $$
declare
  v_m community_memberships%rowtype;
  v_from text;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;

  select * into v_m from community_memberships where id = p_membership_id for update;
  if not found then raise exception 'membership not found' using errcode = '42704'; end if;
  if not is_owner(v_m.community_id, auth.uid()) then
    raise exception 'only an owner may restore a member' using errcode = '42501';
  end if;

  v_from := v_m.status;
  update community_memberships set
    status = 'approved',
    status_changed_at = now(),
    status_changed_by_id = auth.uid(),
    status_reason = null
  where id = p_membership_id and status in ('suspended', 'removed')
  returning * into v_m;
  if not found then raise exception 'member is not suspended or removed' using errcode = '40001'; end if;

  perform _log_membership_event(v_m.id, v_m.community_id, 'member_restored', v_from, 'approved', null, null);

  insert into notifications (recipient_user_id, type, category, title, message, community_id, actor_id, actor_name, navigation_target)
  select v_m.user_id, 'membership_restored', 'roleUpdates', 'Access restored',
    format('Your access to %s has been restored.', (select name from communities where id = v_m.community_id)),
    v_m.community_id, auth.uid(), coalesce(nullif(_current_display_name(), ''), 'An owner'),
    jsonb_build_object('communityId', v_m.community_id, 'role', 'worker')
  where v_m.user_id is distinct from auth.uid();

  return v_m;
end;
$$;

-- ================================================================
-- 8c. remove_member — approved|suspended -> removed. Same auth rules as
--     suspend. Strips owner_grant + buyer_grant + every site_membership +
--     any buyer_request for that user in this community, all in the same
--     transaction — no orphaned elevated access.
-- ================================================================
create or replace function remove_member(p_membership_id uuid, p_reason text default null)
returns community_memberships
language plpgsql security definer set search_path = public as $$
declare
  v_m community_memberships%rowtype;
  v_target_is_owner boolean;
  v_sites_removed int;
  v_had_owner_grant boolean;
  v_had_buyer_grant boolean;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;

  select * into v_m from community_memberships where id = p_membership_id for update;
  if not found then raise exception 'membership not found' using errcode = '42704'; end if;

  if not is_owner(v_m.community_id, auth.uid()) then
    raise exception 'only an owner may remove a member' using errcode = '42501';
  end if;
  if v_m.user_id = auth.uid() then
    raise exception 'you cannot remove yourself — use leave instead' using errcode = '42501';
  end if;
  if is_creator(v_m.community_id, v_m.user_id) then
    raise exception 'the company creator cannot be removed' using errcode = '42501';
  end if;
  v_target_is_owner := has_owner_grant(v_m.community_id, v_m.user_id);
  if v_target_is_owner and not is_creator(v_m.community_id, auth.uid()) then
    raise exception 'only the company creator may remove another owner' using errcode = '42501';
  end if;

  update community_memberships set
    status = 'removed',
    status_changed_at = now(),
    status_changed_by_id = auth.uid(),
    status_reason = p_reason
  where id = p_membership_id and status in ('approved', 'suspended')
  returning * into v_m;
  if not found then raise exception 'member is not active or suspended' using errcode = '40001'; end if;

  v_had_owner_grant := exists (select 1 from owner_grants where community_id = v_m.community_id and user_id = v_m.user_id);
  v_had_buyer_grant := exists (select 1 from buyer_grants where community_id = v_m.community_id and user_id = v_m.user_id);
  delete from owner_grants where community_id = v_m.community_id and user_id = v_m.user_id;
  delete from buyer_grants where community_id = v_m.community_id and user_id = v_m.user_id;
  delete from site_memberships where community_id = v_m.community_id and user_id = v_m.user_id;
  get diagnostics v_sites_removed = row_count;
  delete from buyer_requests where community_id = v_m.community_id and user_id = v_m.user_id;

  perform _log_membership_event(
    v_m.id, v_m.community_id, 'member_removed', v_m.status, 'removed', p_reason,
    jsonb_build_object('ownerGrantRevoked', v_had_owner_grant, 'buyerGrantRevoked', v_had_buyer_grant, 'siteMembershipsRemoved', v_sites_removed)
  );

  insert into notifications (recipient_user_id, type, category, title, message, community_id, actor_id, actor_name, navigation_target)
  select v_m.user_id, 'membership_removed', 'roleUpdates', 'Removed from company',
    format('You have been removed from %s.', (select name from communities where id = v_m.community_id)),
    v_m.community_id, auth.uid(), coalesce(nullif(_current_display_name(), ''), 'An owner'),
    jsonb_build_object('communityId', v_m.community_id, 'view', 'profile')
  where v_m.user_id is distinct from auth.uid();

  return v_m;
end;
$$;

-- ================================================================
-- 8d. leave_community — the member themself, approved -> left. The
--     company creator cannot leave. A granted owner CAN leave (their
--     owner grant is dropped too). Strips the caller's own grants + site
--     memberships + buyer requests. Notifies every owner.
-- ================================================================
create or replace function leave_community(p_community_id uuid)
returns community_memberships
language plpgsql security definer set search_path = public as $$
declare
  v_m community_memberships%rowtype;
  v_actor_name text;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if is_creator(p_community_id, auth.uid()) then
    raise exception 'the company creator cannot leave their own company' using errcode = '42501';
  end if;

  select * into v_m from community_memberships
  where community_id = p_community_id and user_id = auth.uid() for update;
  if not found then raise exception 'you are not a member of this company' using errcode = '42704'; end if;

  update community_memberships set
    status = 'left',
    status_changed_at = now(),
    status_changed_by_id = auth.uid(),
    status_reason = null
  where id = v_m.id and status = 'approved'
  returning * into v_m;
  if not found then raise exception 'you are not an active member' using errcode = '40001'; end if;

  delete from owner_grants where community_id = p_community_id and user_id = auth.uid();
  delete from buyer_grants where community_id = p_community_id and user_id = auth.uid();
  delete from site_memberships where community_id = p_community_id and user_id = auth.uid();
  delete from buyer_requests where community_id = p_community_id and user_id = auth.uid();

  perform _log_membership_event(v_m.id, p_community_id, 'member_left', 'approved', 'left', null, null);

  v_actor_name := coalesce(nullif(_current_display_name(), ''), 'A member');
  insert into notifications (recipient_user_id, type, category, title, message, community_id, actor_id, actor_name, navigation_target)
  select uid, 'member_left', 'roleUpdates', 'A member left',
    format('%s left %s.', v_actor_name, (select name from communities where id = p_community_id)),
    p_community_id, auth.uid(), v_actor_name,
    jsonb_build_object('communityId', p_community_id, 'role', 'owner')
  from (
    select owner_id as uid from communities where id = p_community_id
    union select user_id from owner_grants where community_id = p_community_id
  ) owners
  where uid is distinct from auth.uid() and notification_type_enabled_for(uid, 'member_left');

  return v_m;
end;
$$;

-- ================================================================
-- 8e. rerequest_membership — the person themself, declined|left|removed
--     -> pending. Resets requested_at + clears the prior decision so the
--     owner's pending list treats it as fresh. Does not notify (matches
--     the initial requestToJoin, which also doesn't notify owners today).
-- ================================================================
create or replace function rerequest_membership(p_community_id uuid)
returns community_memberships
language plpgsql security definer set search_path = public as $$
declare
  v_m community_memberships%rowtype;
  v_from text;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;

  select * into v_m from community_memberships
  where community_id = p_community_id and user_id = auth.uid() for update;
  if not found then raise exception 'you have no prior membership record for this company' using errcode = '42704'; end if;

  v_from := v_m.status;
  update community_memberships set
    status = 'pending',
    requested_at = now(),
    decided_at = null,
    decided_by_id = null,
    status_changed_at = now(),
    status_changed_by_id = auth.uid(),
    status_reason = null
  where id = v_m.id and status in ('declined', 'left', 'removed')
  returning * into v_m;
  if not found then raise exception 'your membership is not in a re-requestable state' using errcode = '40001'; end if;

  perform _log_membership_event(v_m.id, p_community_id, 'member_rerequested', v_from, 'pending', null, null);
  return v_m;
end;
$$;

-- ================================================================
-- 9. request_join_by_invite_code — recreated so that a caller with a
--    prior declined|left|removed row is put back to 'pending' (justCreated
--    = true, so the UI says "Request sent") instead of being told their
--    old dead-end status. An 'approved'/'pending'/'owner' relationship is
--    returned unchanged, exactly as before. Everything else about this
--    function (0021) is preserved.
-- ================================================================
create or replace function request_join_by_invite_code(p_code text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_community communities%rowtype;
  v_existing community_memberships%rowtype;
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select * into v_community from communities where invite_code = upper(trim(p_code));
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  if is_owner(v_community.id, v_user_id) then
    return jsonb_build_object('ok', true, 'status', 'owner', 'justCreated', false,
      'communityId', v_community.id, 'communityName', v_community.name);
  end if;

  select * into v_existing from community_memberships
  where community_id = v_community.id and user_id = v_user_id;

  if found then
    if v_existing.status in ('declined', 'left', 'removed') then
      update community_memberships set
        status = 'pending', requested_at = now(), decided_at = null, decided_by_id = null,
        status_changed_at = now(), status_changed_by_id = v_user_id, status_reason = null
      where id = v_existing.id;
      perform _log_membership_event(v_existing.id, v_community.id, 'member_rerequested', v_existing.status, 'pending', null, null);
      return jsonb_build_object('ok', true, 'status', 'pending', 'justCreated', true,
        'communityId', v_community.id, 'communityName', v_community.name);
    end if;
    return jsonb_build_object('ok', true, 'status', v_existing.status, 'justCreated', false,
      'communityId', v_community.id, 'communityName', v_community.name);
  end if;

  insert into community_memberships (community_id, user_id, status)
  values (v_community.id, v_user_id, 'pending');

  return jsonb_build_object('ok', true, 'status', 'pending', 'justCreated', true,
    'communityId', v_community.id, 'communityName', v_community.name);
end;
$$;

-- ================================================================
-- 10. Grants — authenticated only, never anon/public (same as every RPC
--     since 0013).
-- ================================================================
revoke execute on function suspend_member(uuid, text) from public, anon;
revoke execute on function restore_member(uuid) from public, anon;
revoke execute on function remove_member(uuid, text) from public, anon;
revoke execute on function leave_community(uuid) from public, anon;
revoke execute on function rerequest_membership(uuid) from public, anon;
revoke execute on function request_join_by_invite_code(text) from public, anon;

grant execute on function suspend_member(uuid, text) to authenticated;
grant execute on function restore_member(uuid) to authenticated;
grant execute on function remove_member(uuid, text) to authenticated;
grant execute on function leave_community(uuid) to authenticated;
grant execute on function rerequest_membership(uuid) to authenticated;
grant execute on function request_join_by_invite_code(text) to authenticated;

-- ================================================================
-- 11. Realtime — community_membership_events is NOT added to the
--     supabase_realtime publication. community_memberships already is
--     (0016); a status change rides that existing channel and triggers
--     refreshCommunityCache like every other membership change. The
--     events table is audit-only, read on demand, same reasoning as
--     order_events' deliberate exclusion.
-- ================================================================
