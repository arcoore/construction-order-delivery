-- Phase 8D.2 — Realtime publication membership, plus a narrowly-scoped
-- REPLICA IDENTITY fix (see below) discovered during this phase's own local
-- verification. No RLS policy change, no RPC change, no other schema
-- change. Realtime is a freshness SIGNAL layer only; every event it
-- delivers still leads back to the exact same authoritative
-- refreshXCache() functions (and therefore the exact same RLS policies)
-- that already gate every REST/RPC read in this app — see CLAUDE.md's
-- Notification system / Phase 8B-8C hybrid-backend-state sections and
-- public/js/realtime.js's own header for the "never trust the payload,
-- always refetch" rule this migration exists to support.
--
-- REPLICA IDENTITY — DEFAULT (primary key only) for seven of the ten
-- tables, but FULL for `owner_grants`, `buyer_grants`, `site_memberships`.
-- This is NOT a blanket "upgrade everything to be safe" choice — it was
-- proven necessary, not assumed, during this phase's own local multi-tab
-- verification:
--
--   THE BUG FOUND: a live test revoked a Worker's buyer_grants row (a real
--   DELETE, via the existing revoke_buyer_access RPC) while that Worker's
--   Buyer view sat open in an idle browser tab, subscribed to the
--   community-scoped channel's `buyer_grants` listener filtered on
--   `community_id=eq.<activeCommunityId>`. The event never arrived — the
--   tab's cache still showed the old grant seconds later, with zero
--   errors anywhere. Root cause: under REPLICA IDENTITY DEFAULT, a
--   DELETE's row data in the WAL contains ONLY the primary key column(s)
--   of the deleted row — not `community_id`, which isn't part of this
--   table's primary key. Supabase Realtime evaluates a channel's `filter`
--   option against the row data actually present in the change event; for
--   a DELETE under DEFAULT identity, the filtered column simply isn't
--   there to evaluate, so the event is silently dropped for that
--   subscription rather than delivered or erroring. A follow-up control
--   test (an INSERT into the same table, same filter) propagated
--   correctly within seconds — isolating the gap to DELETE specifically,
--   not the channel/filter/subscription setup in general.
--
--   THE FIX, SCOPED NARROWLY: REPLICA IDENTITY FULL makes a DELETE's WAL
--   entry carry every column of the deleted row (as it stood immediately
--   before deletion), so the `community_id=eq.<x>` filter has something to
--   evaluate again. Grepping every migration file plus every client-side
--   `.delete(` call site found exactly three tables, across this whole
--   app, where a row is ever genuinely DELETEd rather than status-updated:
--     owner_grants      -- community.js's revokeOwnerAccess (direct client delete)
--     buyer_grants      -- revoke_buyer_access RPC (0015)
--     site_memberships  -- remove_site_member RPC (0015)
--   Every other approved table (orders, cancellation_requests, sites,
--   community_memberships, buyer_requests, communities, notifications)
--   never has a row deleted anywhere in this codebase — status columns are
--   updated instead — so DEFAULT identity's gap never actually applies to
--   them; there is nothing to prove necessary there, so they stay at
--   DEFAULT. FULL does cost a little extra WAL volume per write (every
--   column logged, not just the changed ones) — an acceptable, now-
--   justified tradeoff for exactly the three tables where it's the
--   difference between a real live-revalidation feature working or
--   silently not working, and negligible at this app's scale either way.
--
-- No new index is added. The existing indexes (audited directly against
-- pg_indexes before writing this file) already cover every column this
-- app's own REST/RPC queries filter on — and Realtime's own `filter`
-- option is evaluated by the Realtime service against WAL-decoded row
-- data, not via a Postgres index scan, so it has no index dependency of
-- its own to satisfy either.
--
-- Publication membership is applied via a small idempotent DO block (rather
-- than ten plain `ALTER PUBLICATION ... ADD TABLE` statements) so this
-- migration is safe to reason about even if a table were ever added to the
-- publication out-of-band (e.g. a manual Studio "Enable Realtime" toggle) —
-- a plain ADD TABLE errors on an already-member relation; this skips
-- whichever of the ten are already present instead of failing the whole
-- migration. Verified via `pg_publication_tables` immediately before first
-- writing this file that both local and hosted `sitestock-dev` had zero
-- tables in `supabase_realtime` at the time — this was expected to be a
-- genuine no-op guard, not a workaround for a known drift.
-- `ALTER TABLE ... REPLICA IDENTITY` is naturally idempotent on its own
-- (re-running it is a harmless no-op if already set), so it needs no
-- similar guard.
--
-- TABLE SET (matches the approved Phase 8D.2 architecture plan exactly):
--   notifications           -- user-scoped channel (recipient_user_id = auth.uid())
--   orders                  -- community-scoped channel
--   cancellation_requests   -- community-scoped channel
--   sites                   -- community-scoped channel
--   site_memberships        -- community-scoped channel (REPLICA IDENTITY FULL)
--   community_memberships   -- community-scoped channel
--   owner_grants            -- community-scoped channel (REPLICA IDENTITY FULL)
--   buyer_grants            -- community-scoped channel (REPLICA IDENTITY FULL)
--   buyer_requests          -- community-scoped channel
--   communities             -- community-scoped channel
--
-- Deliberately EXCLUDED (per the approved plan, not an oversight):
--   order_events            -- every meaningful change is already implied by
--                              the corresponding `orders` row change in the
--                              same RPC transaction; not worth a second live
--                              channel for a feature (live-ticking an open
--                              timeline) nobody asked for.
--   profiles                -- display-name staleness has zero security
--                              impact and is already self-healing
--                              (identity.js's resolveDisplayName
--                              fetch-on-miss).
--   notification_preferences -- opened deliberately by the user; already
--                              covered by view-entry refresh; not in any of
--                              the seven primary Phase 8D.2 goal examples.

DO $$
DECLARE
  t text;
  realtime_tables text[] := ARRAY[
    'notifications',
    'orders',
    'cancellation_requests',
    'sites',
    'site_memberships',
    'community_memberships',
    'owner_grants',
    'buyer_grants',
    'buyer_requests',
    'communities'
  ];
BEGIN
  FOREACH t IN ARRAY realtime_tables LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;

-- See the header above: proven necessary (not assumed) for exactly these
-- three tables, the only ones anywhere in this codebase where a row is
-- ever genuinely DELETEd rather than status-updated, and therefore the
-- only ones where a DELETE's filtered-column-missing-under-DEFAULT gap can
-- ever actually bite.
ALTER TABLE public.owner_grants REPLICA IDENTITY FULL;
ALTER TABLE public.buyer_grants REPLICA IDENTITY FULL;
ALTER TABLE public.site_memberships REPLICA IDENTITY FULL;
