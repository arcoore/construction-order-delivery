-- Join-request decision notifications + closing a real RLS bypass.
--
-- PROBLEM: an applicant approved or declined for company membership
-- received zero in-app signal — decideJoinRequest (community.js) was a
-- plain client `.update()` on community_memberships, and notifications has
-- no INSERT grant for `authenticated` at all (same discipline as every
-- other notification-creating path in this app since 0007), so a client
-- write could never have created one directly regardless.
--
-- DESIGN: fold the decision into one new SECURITY DEFINER RPC,
-- decide_join_request, rather than keep the plain update and bolt a
-- separate narrow notify_* RPC on afterward. A two-step client sequence
-- would reopen exactly the class of race the 0015 hardening pass already
-- found and closed for buyer-access-revoke/site-member-remove: the
-- underlying row a *separate* notify call re-validates against could have
-- changed between the two client calls (re-decided by another session,
-- etc.). One transaction that locks the row, decides, and notifies closes
-- that atomically. Site assignment during approval stays a genuinely
-- separate, already-correct step (owner.js still calls addSiteMember
-- itself afterward) — it's optional, can target multiple sites, and
-- already has its own isolated notification path (notify_site_member_added,
-- 0014) with its own partial-failure UX; folding it into this RPC would
-- either force an all-or-nothing rollback of the approval itself (a real
-- behavior change, not asked for) or duplicate addSiteMember's own
-- authorization logic for no benefit.
--
-- A REAL BYPASS FOUND DURING THIS MIGRATION'S OWN DESIGN (fixed below, not
-- left in place just because the frontend now uses the RPC): the existing
-- `community_memberships_decide_owner_only` UPDATE policy (0009) checks
-- only `is_owner` — no check on the row's current status, no guard against
-- re-deciding an already-decided request. It was never anything but a thin
-- wrapper around decideJoinRequest's own plain update (grepped: no other
-- code path issues a community_memberships UPDATE), so once the frontend
-- moves to the RPC, that policy becomes a live, unused bypass door — any
-- authenticated owner could still issue a raw client UPDATE, skip the
-- pending-state guard entirely, re-decide a request any number of times,
-- and never trigger a notification. Dropped outright below, mirroring how
-- `orders` already has zero UPDATE policy for `authenticated` at all —
-- every mutation RPC-only, the single most important policy decision in
-- 0009's own words. Nothing else in this codebase relies on direct
-- community_memberships UPDATE access, so removing it costs nothing.

-- ================================================================
-- 1. notifications.type gains two new values (a real CHECK constraint,
--    not an enum — see 0007's own table definition). Unnamed at creation,
--    so Postgres auto-named it `notifications_type_check` (confirmed
--    directly against the live schema before writing this).
-- ================================================================
alter table notifications drop constraint notifications_type_check;
alter table notifications add constraint notifications_type_check check (type in (
  'order_awaiting_approval', 'order_rejected', 'approval_reverted', 'order_ready_for_purchase',
  'delivery_available', 'delivery_claimed', 'delivery_cancelled', 'delivery_collected', 'order_delivered',
  'buyer_access_requested', 'buyer_access_granted', 'buyer_access_rejected', 'buyer_access_revoked',
  'site_member_added', 'site_member_removed', 'site_archived',
  'cancellation_requested', 'cancellation_approved', 'cancellation_rejected',
  'membership_approved', 'membership_declined'
));

-- ================================================================
-- 2. Register the two new types as non-configurable, exactly like
--    buyer_access_granted/buyer_access_revoked — they directly change
--    what the recipient can now do (access a company, or not), so they
--    always fire regardless of the roleUpdates category toggle. The RPC
--    below never calls this function for these two types (it inserts
--    unconditionally, same as notify_site_member_added already does for
--    its own non-configurable type) — registered here purely so this
--    function stays the honest single source of truth for every type's
--    configurability, matching every other non-configurable type's own
--    precedent of being listed here even though its own creation path
--    doesn't call it either.
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
-- 3. Close the bypass — no direct UPDATE path on community_memberships
--    for `authenticated` at all, mirroring `orders`. decide_join_request
--    (SECURITY DEFINER, below) becomes the sole path, exactly like every
--    order-lifecycle transition already works.
-- ================================================================
drop policy community_memberships_decide_owner_only on community_memberships;

-- ================================================================
-- 4. decide_join_request — the guarded RPC.
--
-- State machine: pending -> approved | declined, exactly once. The
-- `where status = 'pending'` guard on the UPDATE itself (not a separate
-- SELECT-then-check, which would race) is what makes a double-click, a
-- replay, or two competing owner sessions all resolve to "exactly one
-- write wins, everyone else gets a clean 40001 refusal" — the identical
-- discipline every order-lifecycle RPC already uses for exactly the same
-- reason.
-- ================================================================
create or replace function decide_join_request(p_request_id uuid, p_decision text)
returns community_memberships
language plpgsql security definer set search_path = public as $$
declare
  v_request community_memberships%rowtype;
  v_community communities%rowtype;
  v_actor_name text;
  v_message text;
  v_type text;
  v_title text;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  if p_decision not in ('approved', 'declined') then
    raise exception 'decision must be approved or declined' using errcode = '22023';
  end if;

  select * into v_request from community_memberships where id = p_request_id for update;
  if not found then raise exception 'join request not found' using errcode = '42704'; end if;

  if not is_owner(v_request.community_id, auth.uid()) then
    raise exception 'only an owner may decide this join request' using errcode = '42501';
  end if;

  update community_memberships set
    status = p_decision::membership_status,
    decided_at = now(),
    decided_by_id = auth.uid()
  where id = p_request_id and status = 'pending'
  returning * into v_request;
  if not found then raise exception 'this request has already been decided' using errcode = '40001'; end if;

  select * into v_community from communities where id = v_request.community_id;
  v_actor_name := coalesce(nullif(_current_display_name(), ''), 'The owner');
  v_message := format('Your request to join %s was %s.', v_community.name, p_decision);
  v_type := case when p_decision = 'approved' then 'membership_approved' else 'membership_declined' end;
  v_title := case when p_decision = 'approved' then 'Request approved' else 'Request declined' end;

  -- Non-configurable (see notification_type_enabled_for above) — inserted
  -- unconditionally, same as notify_site_member_added already does for its
  -- own non-configurable type. Self-exclusion guard kept for consistency
  -- with every other notification in this codebase even though an owner
  -- deciding their own pending request should never be reachable in
  -- practice (is_owner already gates the caller above).
  if v_request.user_id is distinct from auth.uid() then
    insert into notifications (recipient_user_id, type, category, title, message, community_id, actor_id, actor_name, navigation_target)
    values (
      v_request.user_id, v_type, 'roleUpdates', v_title, v_message,
      v_request.community_id, auth.uid(), v_actor_name,
      jsonb_build_object('communityId', v_request.community_id, 'role', 'worker')
    );
  end if;

  return v_request;
end;
$$;

revoke execute on function decide_join_request(uuid, text) from public, anon;
grant execute on function decide_join_request(uuid, text) to authenticated;

-- No change to site_memberships, addSiteMember, or notify_site_member_added
-- — approve-time site assignment stays exactly as it is, a separate client
-- step called by owner.js after this RPC succeeds. No change to
-- communities, invite codes, discoverability, order lifecycle, or the
-- Companies-screen Realtime/stale-message fix (public/js/communityView.js,
-- untouched by this migration).
