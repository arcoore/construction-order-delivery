-- Phase 8D.2 — Realtime publication membership (migration 0016). This file
-- deliberately does NOT attempt to test actual websocket delivery — that's
-- a live-client concern, covered by the manual multi-device test plan in
-- PROGRESS.md/supabase/README.md, not something pgTAP (a Postgres-session
-- test framework) can meaningfully exercise. What IS meaningfully testable
-- here, and what this file exists to guard against regressing, is the
-- database-level fact Realtime's own scoping ultimately rests on: exactly
-- the approved ten tables are members of `supabase_realtime`, no more and
-- no fewer — a silent accidental addition (e.g. `profiles`) or removal
-- (breaking a live-freshness feature without anyone noticing) would both be
-- real regressions this test catches on every future `db test`.
begin;
select plan(17);

-- ================================================================
-- items 1-10: every approved table is a real publication member
-- ================================================================
select ok(
  exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notifications'),
  'item 1: notifications is a member of supabase_realtime'
);
select ok(
  exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'orders'),
  'item 2: orders is a member of supabase_realtime'
);
select ok(
  exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'cancellation_requests'),
  'item 3: cancellation_requests is a member of supabase_realtime'
);
select ok(
  exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'sites'),
  'item 4: sites is a member of supabase_realtime'
);
select ok(
  exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'site_memberships'),
  'item 5: site_memberships is a member of supabase_realtime'
);
select ok(
  exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'community_memberships'),
  'item 6: community_memberships is a member of supabase_realtime'
);
select ok(
  exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'owner_grants'),
  'item 7: owner_grants is a member of supabase_realtime'
);
select ok(
  exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'buyer_grants'),
  'item 8: buyer_grants is a member of supabase_realtime'
);
select ok(
  exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'buyer_requests'),
  'item 9: buyer_requests is a member of supabase_realtime'
);
select ok(
  exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'communities'),
  'item 10: communities is a member of supabase_realtime'
);

-- ================================================================
-- items 11-13: the three explicitly-excluded tables are NOT members —
-- guards against someone casually broadening the set later (order_events'
-- changes are already implied by orders; profiles/notification_preferences
-- were deliberately judged not worth a live channel — see 0016's header and
-- CLAUDE.md's Phase 8D.2 section for the reasoning, not just this test).
-- ================================================================
select ok(
  not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'order_events'),
  'item 11: order_events is deliberately NOT a member of supabase_realtime'
);
select ok(
  not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'profiles'),
  'item 12: profiles is deliberately NOT a member of supabase_realtime'
);
select ok(
  not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notification_preferences'),
  'item 13: notification_preferences is deliberately NOT a member of supabase_realtime'
);

-- ================================================================
-- item 14: exactly ten tables total — catches a member added under some
-- other name/schema that the eleven ok()/not-ok() checks above wouldn't
-- individually name-check for.
-- ================================================================
select is(
  (select count(*)::int from pg_publication_tables where pubname = 'supabase_realtime'),
  10,
  'item 14: supabase_realtime has exactly the ten approved members, nothing else'
);

-- ================================================================
-- items 15-17: REPLICA IDENTITY FULL on exactly the three tables where a
-- real DELETE exists (owner_grants/buyer_grants/site_memberships — see
-- 0016's header for the live bug this guards against: a DELETE's WAL entry
-- carries only primary-key columns under DEFAULT identity, so a
-- community_id filter can never match a DELETE event on these tables
-- without FULL, and the event is silently dropped rather than delivered).
-- Every other approved table is intentionally left at DEFAULT, since none
-- of them are ever genuinely deleted anywhere in this codebase (status
-- columns are updated instead) — this test only asserts FULL on the three
-- tables that actually need it, not blanket coverage.
-- ================================================================
select is(
  (select relreplident from pg_class where oid = 'public.owner_grants'::regclass),
  'f',
  'item 15: owner_grants has REPLICA IDENTITY FULL (real DELETE exists — see 0016)'
);
select is(
  (select relreplident from pg_class where oid = 'public.buyer_grants'::regclass),
  'f',
  'item 16: buyer_grants has REPLICA IDENTITY FULL (real DELETE exists — see 0016)'
);
select is(
  (select relreplident from pg_class where oid = 'public.site_memberships'::regclass),
  'f',
  'item 17: site_memberships has REPLICA IDENTITY FULL (real DELETE exists — see 0016)'
);

select * from finish();
rollback;
