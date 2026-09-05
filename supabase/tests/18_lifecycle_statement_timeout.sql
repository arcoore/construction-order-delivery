-- Migration 0024 — stale-intent hardening (database-wide statement_timeout,
-- postgres role exempted).
--
-- IMPORTANT CONTEXT (see the migration's own header for the full story):
-- Supabase's own platform defaults already give the `authenticator` role
-- (PostgREST's actual login role, on both local and hosted) statement_
-- timeout=8s and lock_timeout=8s, independent of this migration. Live
-- two-connection testing (a real `authenticator` login + `SET ROLE
-- authenticated`, matching PostgREST's exact pattern, blocked on a row a
-- second session held via `FOR UPDATE`) confirmed the real request path was
-- ALREADY correctly cancelled at ~8.4s by that pre-existing configuration.
-- This migration's database-wide default is legitimate, verified-working
-- defense-in-depth (and the `postgres` exemption is necessary once you add
-- a database-wide default, so migrations/admin tooling aren't affected) —
-- but it is largely redundant with protection Supabase already provides,
-- not a fix for a gap that didn't already have this specific cover. The
-- likely true cause of the original incident's 90-*minute* delay remains
-- unresolved and is most plausibly a connection-pool-level queue (outside
-- what any statement_timeout/lock_timeout, existing or new, can bound) —
-- see the migration file for why that's a separate, dashboard-level
-- follow-up, not something fixable via SQL.
--
-- This file checks the two `pg_db_role_setting` catalog rows the migration
-- creates, and re-confirms ordinary RPC behaviour is unaffected. It
-- deliberately does NOT check pg_proc.proconfig / a per-function SET —
-- that approach was tried first and proven, via live testing, not to bound
-- execution at all (the override doesn't take effect early enough to
-- affect the outer statement's already-computed deadline). The two
-- settings checked here are the ones verified live to actually work:
--   * database default statement_timeout = 8s (setrole = 0, i.e. "any
--     role"), which is what PostgREST's pooled-connection-plus-SET-ROLE
--     pattern would inherit for any role without its own override;
--   * an explicit statement_timeout = 0 override for the `postgres` role
--     specifically (a real login role, unlike `authenticated`/`anon` which
--     are only ever reached via SET ROLE), so migrations/admin tooling are
--     never affected.
--
-- The actual "a blocked lock wait gets cut off at ~8s instead of hanging
-- indefinitely" behaviour requires two real concurrent connections, with
-- the calling session established as a genuine login (not `-U postgres` +
-- `SET ROLE`, which is silently exempted by the override above and would
-- falsely appear to show no timeout in effect for anyone) — outside what a
-- single pgTAP transaction (which runs as postgres, exempted) can exercise.
-- That proof was run separately via raw psql against a real `authenticator`
-- login — see the migration file and PROGRESS.md for the exact result,
-- matching this project's existing precedent for genuine concurrency
-- proofs (remove_member, claim_delivery, start_purchase races).
begin;
select plan(5);

select ok(
  exists (
    select 1 from pg_db_role_setting
    where setdatabase = (select oid from pg_database where datname = current_database())
      and setrole = 0
      and 'statement_timeout=8s' = any(setconfig)
  ),
  'database default statement_timeout is 8s (any role, i.e. covers the authenticated/anon pooled-connection path)'
);

select ok(
  exists (
    select 1 from pg_db_role_setting
    where setdatabase = 0
      and setrole = (select oid from pg_roles where rolname = 'postgres')
      and 'statement_timeout=0' = any(setconfig)
  ),
  'postgres role is explicitly exempted (statement_timeout=0, global — setdatabase=0 means "all databases"), protecting migrations/admin tooling'
);

-- Smoke tests: ordinary fast-path RPC behaviour is unaffected (this pgTAP
-- session itself runs as postgres, so it is exempt from the 8s default —
-- these are regression checks that nothing else broke, not a test of the
-- timeout firing).
select tests.create_user('st-owner@test.local', 'ST Owner') as owner \gset
select tests.create_user('st-worker@test.local', 'ST Worker') as worker \gset

select tests.authenticate_as(:'owner');
insert into communities (name, invite_code, owner_id) values ('ST Co', 'STCO01', :'owner') returning id as co \gset
insert into sites (community_id, name, created_by_id) values (:'co', 'ST Site', :'owner') returning id as site \gset

select tests.authenticate_as(:'worker');
insert into community_memberships (community_id, user_id, status) values (:'co', :'worker', 'pending') returning id as m_worker \gset

select tests.authenticate_as(:'owner');
select is((decide_join_request(:'m_worker', 'approved')).status, 'approved',
  'smoke test: decide_join_request still works normally after hardening');

insert into site_memberships (site_id, community_id, user_id, added_by_id) values (:'site', :'co', :'worker', :'owner');

select tests.authenticate_as(:'worker');
select (tests.create_order_1(
  :'co', :'site', 'p1', 'ST Product', null, 1, 'unit', 'SW1A 1AA', null, null,
  null, null, null, null, null, 9.99, null, null
)).id as ord \gset

select tests.authenticate_as(:'owner');
select is((approve_order(:'ord')).status, 'pending_purchase',
  'smoke test: approve_order still works normally after hardening');

select tests.authenticate_as(:'worker');
select is((leave_community(:'co')).status, 'left',
  'smoke test: leave_community still works normally after hardening');

select * from finish();
rollback;
