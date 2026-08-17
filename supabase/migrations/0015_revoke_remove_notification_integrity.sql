-- Phase 8D.1 hardening — closes a real, disclosed gap in the pre-commit
-- audit: 0014 is NOT edited (already applied to hosted). Forward-only.
--
-- THE GAP: notify_buyer_access_revoked/notify_site_member_removed (0014)
-- can only re-validate "is the caller currently an owner of this
-- community/site" — the buyer_grants/site_memberships row the client just
-- deleted is already gone by the time the separate notify RPC runs, so
-- there's nothing left to check the claim against. A real owner could call
-- either RPC with an arbitrary recipient uuid and produce a misleading
-- "your access was removed"/"you were removed from this site" notification
-- for someone who was never actually revoked/removed. Not a privilege
-- escalation (the caller must still be a genuine owner, and actor
-- attribution can't be spoofed) but a real notification-content-integrity
-- defect — the audit was right to flag it.
--
-- THE FIX: make the notification an authoritative side effect of the SAME
-- transaction that performs the removal, exactly like every order-lifecycle
-- RPC already does for order_events. Two new RPCs, `revoke_buyer_access`
-- and `remove_site_member`, replace the old two-step "client deletes the
-- row directly, then separately calls a notify RPC" pattern for exactly
-- these two operations — nothing else changes. Each new RPC:
--   1. requires auth.uid()
--   2. verifies owner authority (is_owner, derived from the site's own
--      community_id for remove_site_member — never a client-supplied one)
--   3. performs the DELETE itself, and checks Postgres's own `FOUND`
--      variable — if zero rows matched, the row never existed (or was
--      already removed by someone else), and the function refuses with a
--      real error INSTEAD of silently succeeding — no notification is ever
--      reachable on that path, because the notification INSERT sits after
--      this check, exactly like every order-lifecycle RPC's guarded UPDATE.
--   4. inserts the notification, in the same transaction, only once the
--      DELETE has been proven to have actually removed a real row.
-- This is strictly stronger than the old design: the database itself now
-- proves the removed row genuinely existed, rather than trusting the
-- client's own "wasMember" convenience check (which stays in the UI for
-- fast-fail UX, but is no longer anywhere near the security boundary).
--
-- The five other notify_* RPCs from 0014 (granted, requested, rejected,
-- site_member_added, site_archived) are UNCHANGED — the audit found they
-- already validate against a fact that genuinely persists (an existing
-- grant/membership row, or status+decided_by_id/archived_by_id on a row
-- that is never deleted), so they don't have this class of gap.
--
-- The two superseded RPCs (notify_buyer_access_revoked,
-- notify_site_member_removed) are NOT dropped (their function bodies stay
-- exactly as 0014 defined them, so this migration never touches 0014's own
-- objects) — their EXECUTE grant to `authenticated` is revoked instead, so
-- they become permanently unreachable by any client. This closes the gap
-- outright rather than just adding a better alternative alongside the
-- still-callable old one.
--
-- No order-lifecycle RPC, RLS policy, or grant unrelated to this narrow
-- fix is touched.

-- ================================================================
-- revoke_buyer_access — authoritative delete + notification, one transaction
-- ================================================================
create or replace function revoke_buyer_access(p_community_id uuid, p_recipient_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare v_actor_name text;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not is_owner(p_community_id, auth.uid()) then
    raise exception 'only an owner may revoke buyer access' using errcode = '42501';
  end if;

  delete from buyer_grants
  where community_id = p_community_id and user_id = p_recipient_id;
  if not found then
    raise exception 'no matching buyer grant to revoke' using errcode = '42704';
  end if;

  v_actor_name := coalesce(nullif(_current_display_name(), ''), 'An owner');
  if p_recipient_id is distinct from auth.uid() then
    insert into notifications (recipient_user_id, type, category, title, message, community_id, actor_id, actor_name, navigation_target)
    values (p_recipient_id, 'buyer_access_revoked', 'roleUpdates', 'Buyer access removed',
      format('%s removed your buyer access.', v_actor_name), p_community_id, auth.uid(), v_actor_name,
      jsonb_build_object('communityId', p_community_id));
  end if;
end;
$$;

-- ================================================================
-- remove_site_member — authoritative delete + notification, one transaction
-- ================================================================
create or replace function remove_site_member(p_site_id uuid, p_recipient_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare v_site sites%rowtype; v_actor_name text;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select * into v_site from sites where id = p_site_id;
  if not found then raise exception 'site not found' using errcode = '42704'; end if;
  if not is_owner(v_site.community_id, auth.uid()) then
    raise exception 'only an owner may remove employees from a site' using errcode = '42501';
  end if;

  delete from site_memberships
  where site_id = p_site_id and user_id = p_recipient_id;
  if not found then
    raise exception 'no matching site membership to remove' using errcode = '42704';
  end if;

  v_actor_name := coalesce(nullif(_current_display_name(), ''), 'An owner');
  if p_recipient_id is distinct from auth.uid() then
    insert into notifications (recipient_user_id, type, category, title, message, community_id, site_id, actor_id, actor_name, navigation_target)
    values (p_recipient_id, 'site_member_removed', 'roleUpdates', 'Removed from a site',
      format('%s removed you from %s.', v_actor_name, v_site.name), v_site.community_id, v_site.id, auth.uid(), v_actor_name,
      jsonb_build_object('communityId', v_site.community_id, 'role', 'worker', 'siteId', v_site.id));
  end if;
end;
$$;

-- ================================================================
-- Grants for the two new RPCs — same authenticated-only pattern as every
-- other notify_*/lifecycle RPC.
-- ================================================================
revoke execute on function
  revoke_buyer_access(uuid, uuid),
  remove_site_member(uuid, uuid)
from public, anon;

grant execute on function
  revoke_buyer_access(uuid, uuid),
  remove_site_member(uuid, uuid)
to authenticated;

-- ================================================================
-- Close the gap outright: the two superseded 0014 RPCs are no longer
-- reachable by any client role. Their function bodies are untouched
-- (0014 is not edited) — only their ACL changes.
-- ================================================================
revoke execute on function
  notify_buyer_access_revoked(uuid, uuid),
  notify_site_member_removed(uuid, uuid)
from authenticated, public, anon;
