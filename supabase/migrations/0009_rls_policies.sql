-- Row Level Security — the real security boundary. Every table gets RLS
-- explicitly enabled (a forgotten "ENABLE ROW LEVEL SECURITY" is the single
-- most common real-world Supabase misconfiguration and leaves a table wide
-- open by default). Fail closed: no policy means no access.
--
-- Design rule applied consistently below: simple, single-row, CRUD-shaped
-- state changes (join/decline, grant/revoke, site membership) are exposed
-- via direct RLS-gated INSERT/UPDATE/DELETE. Anything with multi-step
-- conditional logic or that must append an audit event atomically (every
-- order-lifecycle transition) gets NO direct INSERT/UPDATE grant at all —
-- those tables are writable only through the SECURITY DEFINER RPC functions
-- in 0010, which re-derive permission from auth.uid() themselves. A missing
-- INSERT/UPDATE policy on `orders`/`order_events`/`cancellation_requests`
-- for the `authenticated` role is intentional, not an oversight.

alter table profiles enable row level security;
alter table communities enable row level security;
alter table community_memberships enable row level security;
alter table owner_grants enable row level security;
alter table buyer_grants enable row level security;
alter table buyer_requests enable row level security;
alter table sites enable row level security;
alter table site_memberships enable row level security;
alter table orders enable row level security;
alter table order_events enable row level security;
alter table cancellation_requests enable row level security;
alter table notifications enable row level security;
alter table notification_preferences enable row level security;

-- RLS policies only ever narrow access that the role already has at the
-- plain SQL GRANT level — they are a second, row-level filter, not a
-- replacement for the standard object privilege system. On a real hosted
-- Supabase project this base grant is provisioned automatically by the
-- platform; a database built purely from these migration files (exactly
-- what this local verification proved) has none of that by default, so it
-- must be declared explicitly here. Scoped to match each table's actual
-- policies below — no INSERT/UPDATE grant on orders/order_events/
-- cancellation_requests, since those are RPC-only by design (0010's
-- functions run SECURITY DEFINER as the function owner, which is
-- unaffected by these grants).
grant usage on schema public to authenticated, anon;

grant select, update on profiles to authenticated;
grant select, insert, update on communities to authenticated;
grant select, insert, update on community_memberships to authenticated;
grant select, insert, delete on owner_grants to authenticated;
grant select, insert, delete on buyer_grants to authenticated;
grant select, insert, update on buyer_requests to authenticated;
grant select, insert, update on sites to authenticated;
grant select, insert, delete on site_memberships to authenticated;
grant select on orders to authenticated;
grant select on order_events to authenticated;
grant select on cancellation_requests to authenticated;
grant select, update on notifications to authenticated;
grant select, insert, update on notification_preferences to authenticated;

-- ---------------------------------------------------------------- profiles
-- display_name carries no sensitive information by design and must resolve
-- for anyone across the app (community owner labels, team panels, order
-- actor snapshots) — matches identity.js's resolveDisplayName being callable
-- for any known id. No INSERT policy: rows are created only by the
-- on_auth_user_created trigger (SECURITY DEFINER, bypasses RLS).
create policy profiles_select_any on profiles
  for select to authenticated using (true);

create policy profiles_update_own on profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- ------------------------------------------------------------- communities
create policy communities_select_any on communities
  for select to authenticated using (true);

create policy communities_insert_self_as_owner on communities
  for insert to authenticated
  with check (owner_id = auth.uid());

create policy communities_update_owner_only on communities
  for update to authenticated
  using (is_owner(id, auth.uid()))
  with check (is_owner(id, auth.uid()));

-- no delete policy — community deletion is not a feature today.

-- ----------------------------------------------------- community_memberships
create policy community_memberships_select on community_memberships
  for select to authenticated
  using (user_id = auth.uid() or is_owner(community_id, auth.uid()));

-- A user may only ever request membership for themselves, and only in the
-- pending state — approving/declining is a separate UPDATE by an owner.
create policy community_memberships_insert_self_pending on community_memberships
  for insert to authenticated
  with check (user_id = auth.uid() and status = 'pending');

create policy community_memberships_decide_owner_only on community_memberships
  for update to authenticated
  using (is_owner(community_id, auth.uid()))
  with check (is_owner(community_id, auth.uid()));

-- --------------------------------------------------------------- owner_grants
create policy owner_grants_select on owner_grants
  for select to authenticated
  using (user_id = auth.uid() or is_owner(community_id, auth.uid()));

-- Only the true creator may grant further owner access (mirrors
-- community.js: "a granted owner cannot themselves grant further").
create policy owner_grants_insert_creator_only on owner_grants
  for insert to authenticated
  with check (is_creator(community_id, auth.uid()));

create policy owner_grants_delete_creator_only on owner_grants
  for delete to authenticated
  using (is_creator(community_id, auth.uid()));

-- --------------------------------------------------------------- buyer_grants
create policy buyer_grants_select on buyer_grants
  for select to authenticated
  using (user_id = auth.uid() or is_owner(community_id, auth.uid()));

-- Any owner (not creator-restricted) may grant/revoke buyer access.
create policy buyer_grants_insert_owner on buyer_grants
  for insert to authenticated
  with check (is_owner(community_id, auth.uid()));

create policy buyer_grants_delete_owner on buyer_grants
  for delete to authenticated
  using (is_owner(community_id, auth.uid()));

-- -------------------------------------------------------------- buyer_requests
create policy buyer_requests_select on buyer_requests
  for select to authenticated
  using (user_id = auth.uid() or is_owner(community_id, auth.uid()));

create policy buyer_requests_insert_self_pending on buyer_requests
  for insert to authenticated
  with check (user_id = auth.uid() and status = 'pending');

create policy buyer_requests_decide_owner_only on buyer_requests
  for update to authenticated
  using (is_owner(community_id, auth.uid()))
  with check (is_owner(community_id, auth.uid()));

-- ------------------------------------------------------------------- sites
-- Deliberately NOT can_access_site(id, community_id, auth.uid()) here, even
-- though that's logically equivalent — can_access_site's internal
-- "exists (select 1 from sites where id = ...)" existence check is meant
-- for OTHER tables verifying a referenced site is real, and is redundant
-- when sites checks access to its OWN row. Local verification (Phase
-- 8A.5) surfaced a real bug from using it here anyway: on INSERT ...
-- RETURNING, Postgres evaluates this SELECT policy against the row the
-- same statement just wrote, and that self-referential re-query of `sites`
-- does not see its own not-yet-externally-visible row within the same
-- command, so the existence check spuriously failed and the RETURNING was
-- refused even though the INSERT's own WITH CHECK had already passed.
-- Testing the row's own community_id/id directly (no re-query) avoids the
-- self-visibility issue entirely.
create policy sites_select on sites
  for select to authenticated
  using (is_owner(community_id, auth.uid()) or is_site_member(id, auth.uid()));

create policy sites_insert_owner_only on sites
  for insert to authenticated
  with check (is_owner(community_id, auth.uid()));

create policy sites_update_owner_only on sites
  for update to authenticated
  using (is_owner(community_id, auth.uid()))
  with check (is_owner(community_id, auth.uid()));

-- no delete policy — archive only, matches "no permanent-delete function."

-- --------------------------------------------------------- site_memberships
create policy site_memberships_select on site_memberships
  for select to authenticated
  using (user_id = auth.uid() or is_owner(community_id, auth.uid()));

create policy site_memberships_insert_owner_only on site_memberships
  for insert to authenticated
  with check (is_owner(community_id, auth.uid()));

create policy site_memberships_delete_owner_only on site_memberships
  for delete to authenticated
  using (is_owner(community_id, auth.uid()));

-- ------------------------------------------------------------------ orders
-- Deliberately broad, matching the ACTUAL documented visibility model, not
-- an over-restrictive default: an owner sees everything in their company; a
-- requester and the assigned driver always see their own order; anyone who
-- can_access_site sees every order for that site (site.js's "Orders placed
-- from this site" list is not scoped to "my own orders"); any approved
-- member sees the unclaimed driver pool; an authorized buyer sees their
-- purchase queue.
create policy orders_select on orders
  for select to authenticated
  using (
    is_owner(community_id, auth.uid())
    or requested_by_id = auth.uid()
    or driver_id = auth.uid()
    or can_access_site(site_id, community_id, auth.uid())
    or (status = 'purchased' and driver_id is null and is_approved_member(community_id, auth.uid()))
    or can_purchase_for_site(site_id, community_id, auth.uid())
  );

-- No INSERT/UPDATE/DELETE policy for the authenticated role at all — every
-- mutation goes through the RPC functions in 0010. This is the single most
-- important policy decision in this file: it makes "the UI just doesn't
-- render a button" structurally irrelevant, because the table itself
-- refuses a raw write from any client regardless of what the UI does.

-- ---------------------------------------------------------------- order_events
create policy order_events_select on order_events
  for select to authenticated
  using (
    exists (
      select 1 from orders o
      where o.id = order_id
        and (
          is_owner(o.community_id, auth.uid())
          or o.requested_by_id = auth.uid()
          or o.driver_id = auth.uid()
          or can_access_site(o.site_id, o.community_id, auth.uid())
          or can_purchase_for_site(o.site_id, o.community_id, auth.uid())
        )
    )
  );

-- No INSERT/UPDATE/DELETE policy at all — rows are written exclusively by
-- the SECURITY DEFINER RPC functions, which never update or delete an
-- existing row, only ever insert new ones.

-- ----------------------------------------------------- cancellation_requests
create policy cancellation_requests_select on cancellation_requests
  for select to authenticated
  using (
    requested_by_id = auth.uid()
    or is_owner(community_id, auth.uid())
    or can_purchase_for_site(site_id, community_id, auth.uid())
  );

-- No INSERT/UPDATE/DELETE policy — created by request_cancellation(),
-- decided by decide_cancellation_request(), both in 0010.

-- ------------------------------------------------------------- notifications
-- recipient_user_id is the only field that ever decides ownership.
create policy notifications_select_own on notifications
  for select to authenticated
  using (recipient_user_id = auth.uid());

-- A recipient may only ever toggle their own read/read_at — enforced by
-- restricting which rows the UPDATE can target; column-level restriction is
-- left to application discipline in Phase 8A (this table is not wired to
-- the frontend yet — revisit if/when a client is given direct UPDATE
-- access in a later phase).
create policy notifications_update_own_read_state on notifications
  for update to authenticated
  using (recipient_user_id = auth.uid())
  with check (recipient_user_id = auth.uid());

-- No INSERT policy — notifications are always a system-generated side
-- effect of another action, never a direct user write. (No RPC creates them
-- yet either — that's Phase 8D; the table exists now so the schema is
-- ready.)

-- ----------------------------------------------------- notification_preferences
create policy notification_preferences_select_own on notification_preferences
  for select to authenticated
  using (user_id = auth.uid());

create policy notification_preferences_upsert_own on notification_preferences
  for insert to authenticated
  with check (user_id = auth.uid());

create policy notification_preferences_update_own on notification_preferences
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
