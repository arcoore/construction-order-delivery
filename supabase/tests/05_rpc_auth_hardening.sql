-- Phase 8C.5 security hotfix (migration 0013) — regression coverage for the
-- edit_order anon-execute gap and the auth.uid()-null-bypass class of bug it
-- belonged to. See 0013_harden_rpc_auth_and_grants.sql's header for the full
-- root-cause writeup; this file exists so that class of mistake can never
-- silently reappear in a future migration without failing the suite.
--
-- Three independent layers are tested separately on purpose, not just
-- "does it error":
--   A. GRANT-level: literally connecting as the `anon` role and attempting
--      a real call — proves PostgREST/Postgres itself refuses entry before
--      the function body ever runs, for the actual exploited function
--      (edit_order) and others, not just introspected via pg_catalog.
--   B. FUNCTION-BODY defense-in-depth: role = authenticated (so the GRANT
--      layer would let the call through) but with no JWT claims set, so
--      auth.uid() is NULL — this is the specific scenario 0013's explicit
--      `if auth.uid() is null` guard exists for, and would be needed even
--      if a future migration ever reintroduced a grant mistake.
--   C. Ownership-by-id, not by-name, still holds after switching `!=` to
--      `is distinct from` — two users sharing a display name must not be
--      confusable.
begin;
select plan(15);

-- --------------------------------------------------------- A: signature sanity
-- If any signature below is typo'd, to_regprocedure() silently returns NULL
-- and has_function_privilege(role, NULL, ...) would make every later check
-- in this file a false pass. Checked first and separately so a broken test
-- fails loudly as itself, not as a silent false "no anon access" result.
with lifecycle_fns(sig) as (
  values
    ('create_order(uuid, uuid, text, text, text, numeric, text, text, double precision, double precision, text, text, text, text, text, numeric, text, timestamptz)'),
    ('edit_order(uuid, integer, text, text, text, numeric, text, text, double precision, double precision, uuid, text, text, text, text, text, numeric, text, timestamptz)'),
    ('approve_order(uuid)'),
    ('reject_order(uuid, text)'),
    ('revert_approval(uuid)'),
    ('start_purchase(uuid)'),
    ('abandon_purchase(uuid)'),
    ('complete_purchase(uuid)'),
    ('claim_delivery(uuid)'),
    ('cancel_delivery(uuid, text)'),
    ('mark_collected(uuid)'),
    ('mark_delivered(uuid, timestamptz, text)'),
    ('cancel_order_direct(uuid, text)'),
    ('request_cancellation(uuid, text)'),
    ('decide_cancellation_request(uuid, cancellation_request_status, text)')
)
select is(
  (select count(*) from lifecycle_fns where to_regprocedure('public.' || sig) is null)::int, 0,
  'all 15 lifecycle RPC signatures in this test resolve to real functions (catches drift/typos in this file itself)'
);

-- --------------------------------------------------- A: grant-privilege audit
with lifecycle_fns(sig) as (
  values
    ('create_order(uuid, uuid, text, text, text, numeric, text, text, double precision, double precision, text, text, text, text, text, numeric, text, timestamptz)'),
    ('edit_order(uuid, integer, text, text, text, numeric, text, text, double precision, double precision, uuid, text, text, text, text, text, numeric, text, timestamptz)'),
    ('approve_order(uuid)'),
    ('reject_order(uuid, text)'),
    ('revert_approval(uuid)'),
    ('start_purchase(uuid)'),
    ('abandon_purchase(uuid)'),
    ('complete_purchase(uuid)'),
    ('claim_delivery(uuid)'),
    ('cancel_delivery(uuid, text)'),
    ('mark_collected(uuid)'),
    ('mark_delivered(uuid, timestamptz, text)'),
    ('cancel_order_direct(uuid, text)'),
    ('request_cancellation(uuid, text)'),
    ('decide_cancellation_request(uuid, cancellation_request_status, text)')
),
checked as (
  select sig, to_regprocedure('public.' || sig) as oid from lifecycle_fns
)
select is(
  (select count(*) from checked where has_function_privilege('anon', oid, 'EXECUTE'))::int, 0,
  'REGRESSION GUARD: no lifecycle RPC is anon-executable (this is the exact edit_order gap 0013 closed)'
);

with lifecycle_fns(sig) as (
  values
    ('create_order(uuid, uuid, text, text, text, numeric, text, text, double precision, double precision, text, text, text, text, text, numeric, text, timestamptz)'),
    ('edit_order(uuid, integer, text, text, text, numeric, text, text, double precision, double precision, uuid, text, text, text, text, text, numeric, text, timestamptz)'),
    ('approve_order(uuid)'),
    ('reject_order(uuid, text)'),
    ('revert_approval(uuid)'),
    ('start_purchase(uuid)'),
    ('abandon_purchase(uuid)'),
    ('complete_purchase(uuid)'),
    ('claim_delivery(uuid)'),
    ('cancel_delivery(uuid, text)'),
    ('mark_collected(uuid)'),
    ('mark_delivered(uuid, timestamptz, text)'),
    ('cancel_order_direct(uuid, text)'),
    ('request_cancellation(uuid, text)'),
    ('decide_cancellation_request(uuid, cancellation_request_status, text)')
),
checked as (
  select sig, to_regprocedure('public.' || sig) as oid from lifecycle_fns
)
select is(
  (select count(*) from checked where has_function_privilege('public', oid, 'EXECUTE'))::int, 0,
  'REGRESSION GUARD: no lifecycle RPC retains a bare PUBLIC execute grant (the actual root cause: CREATE FUNCTION defaults to granting PUBLIC)'
);

with lifecycle_fns(sig) as (
  values
    ('create_order(uuid, uuid, text, text, text, numeric, text, text, double precision, double precision, text, text, text, text, text, numeric, text, timestamptz)'),
    ('edit_order(uuid, integer, text, text, text, numeric, text, text, double precision, double precision, uuid, text, text, text, text, text, numeric, text, timestamptz)'),
    ('approve_order(uuid)'),
    ('reject_order(uuid, text)'),
    ('revert_approval(uuid)'),
    ('start_purchase(uuid)'),
    ('abandon_purchase(uuid)'),
    ('complete_purchase(uuid)'),
    ('claim_delivery(uuid)'),
    ('cancel_delivery(uuid, text)'),
    ('mark_collected(uuid)'),
    ('mark_delivered(uuid, timestamptz, text)'),
    ('cancel_order_direct(uuid, text)'),
    ('request_cancellation(uuid, text)'),
    ('decide_cancellation_request(uuid, cancellation_request_status, text)')
),
checked as (
  select sig, to_regprocedure('public.' || sig) as oid from lifecycle_fns
)
select is(
  (select count(*) from checked where not has_function_privilege('authenticated', oid, 'EXECUTE'))::int, 0,
  'every lifecycle RPC remains authenticated-executable (the fix revoked anon/public without accidentally over-revoking authenticated)'
);

-- ------------------------------------------------- B: real anonymous RPC calls
-- Not grant introspection — literal connections as `anon` attempting a real
-- call, proving Postgres itself refuses at the permission layer.
select tests.clear_authentication(); -- sets role = anon

select throws_ok(
  format($$ select edit_order(%L, 1, 'p1', 'Cement', '25kg bag', 5, 'bag', 'SW1A 1AA', null, null, %L, 'b1', 'M', 'm.co.uk', 'SW1 1AA', 'today', 6.75, null, null) $$,
    gen_random_uuid(), gen_random_uuid()),
  '42501', null,
  'THE EXPLOIT ITSELF: an anonymous (unauthenticated) caller cannot execute edit_order at all — refused before the function body even runs'
);

select throws_ok(
  format($$ select create_order(%L, %L, 'p1', 'Cement', '25kg bag', 5, 'bag', 'SW1A 1AA', null, null, 'b1', 'M', 'm.co.uk', 'SW1 1AA', 'today', 6.75, null, null) $$,
    gen_random_uuid(), gen_random_uuid()),
  '42501', null,
  'an anonymous caller cannot execute create_order either — the grant fix covers more than just the one exploited function'
);

select throws_ok(
  format($$ select claim_delivery(%L) $$, gen_random_uuid()),
  '42501', null,
  'an anonymous caller cannot execute claim_delivery'
);

-- ------------------------------------- C: defense-in-depth (authenticated role, NULL auth.uid())
-- Simulates a session that somehow has the `authenticated` grant but no
-- valid JWT — the exact case the explicit `auth.uid() is null` guard exists
-- for, independent of whether grants are ever correct. If this guard were
-- ever removed, these three would instead either silently proceed (bad) or
-- fail later with an unrelated error (order not found), not this specific
-- 'authentication required' message.
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '', true);

select throws_ok(
  format($$ select edit_order(%L, 1, 'p1', 'Cement', '25kg bag', 5, 'bag', 'SW1A 1AA', null, null, %L, 'b1', 'M', 'm.co.uk', 'SW1 1AA', 'today', 6.75, null, null) $$,
    gen_random_uuid(), gen_random_uuid()),
  '42501', 'authentication required',
  'DEFENSE IN DEPTH: edit_order refuses a NULL auth.uid() via its own explicit guard, not just via the grant'
);

select throws_ok(
  format($$ select create_order(%L, %L, 'p1', 'Cement', '25kg bag', 5, 'bag', 'SW1A 1AA', null, null, 'b1', 'M', 'm.co.uk', 'SW1 1AA', 'today', 6.75, null, null) $$,
    gen_random_uuid(), gen_random_uuid()),
  '42501', 'authentication required',
  'DEFENSE IN DEPTH: create_order refuses a NULL auth.uid() via its own explicit guard'
);

select throws_ok(
  format($$ select claim_delivery(%L) $$, gen_random_uuid()),
  '42501', 'authentication required',
  'DEFENSE IN DEPTH: claim_delivery refuses a NULL auth.uid() via its own explicit guard'
);

-- ------------------------------------------------- C: duplicate display names
-- Two real, distinct users who happen to share a display name. Authorization
-- must still be decided purely by id (identity.js's own long-standing rule,
-- now doubly true post-hotfix since the ownership checks use IS DISTINCT
-- FROM rather than a name comparison at any point).
select tests.create_user('same-name-owner@test.local', 'Same Name')  as owner_e \gset
select tests.create_user('same-name-a@test.local', 'Same Name')      as worker_e_a \gset
select tests.create_user('same-name-b@test.local', 'Same Name')      as worker_e_b \gset

select tests.authenticate_as(:'owner_e');
insert into communities (name, invite_code, owner_id) values ('Company E', 'EEEEEE', :'owner_e') returning id as company_e \gset
insert into sites (community_id, name, created_by_id) values (:'company_e', 'Site E', :'owner_e') returning id as site_e \gset

select tests.authenticate_as(:'worker_e_a');
insert into community_memberships (community_id, user_id, status) values (:'company_e', :'worker_e_a', 'pending');
select tests.authenticate_as(:'worker_e_b');
insert into community_memberships (community_id, user_id, status) values (:'company_e', :'worker_e_b', 'pending');
select tests.authenticate_as(:'owner_e');
update community_memberships set status = 'approved', decided_by_id = :'owner_e'
  where community_id = :'company_e' and user_id in (:'worker_e_a', :'worker_e_b');
insert into site_memberships (site_id, community_id, user_id, added_by_id) values
  (:'site_e', :'company_e', :'worker_e_a', :'owner_e'),
  (:'site_e', :'company_e', :'worker_e_b', :'owner_e');

select tests.authenticate_as(:'worker_e_a');
select create_order(:'company_e', :'site_e', 'p1', 'Cement', '25kg bag', 5, 'bag', 'SW1A 1AA', null, null, 'b1', 'Merchant', 'merchant.co.uk', 'SW1 1AA', 'today', 6.75, null, null) as order_result_e \gset
select (:'order_result_e'::orders).id as order_id_e \gset
select (:'order_result_e'::orders).version as order_version_e \gset

select tests.authenticate_as(:'worker_e_b');
select throws_ok(
  format($$ select edit_order(%L, %L, 'p1', 'Cement', '25kg bag', 9, 'bag', 'SW1A 1AA', null, null, %L, 'b1', 'Merchant', 'merchant.co.uk', 'SW1 1AA', 'today', 6.75, null, null) $$,
    :'order_id_e', :'order_version_e', :'site_e'),
  '42501', null,
  'a different user with the SAME display name still cannot edit another requester''s order — authorization is by id, not name'
);
select throws_ok(
  format($$ select cancel_order_direct(%L, 'not mine') $$, :'order_id_e'),
  '42501', null,
  'a different user with the SAME display name still cannot cancel another requester''s order'
);

-- --------------------------------------------------- E: legitimate path still works
-- Proves the hardening didn't break real, authorized usage.
select tests.authenticate_as(:'worker_e_a');
select (select version from orders where id = :'order_id_e') as current_version_e \gset
select lives_ok(
  format($$ select edit_order(%L, %L, 'p1', 'Cement', '25kg bag', 9, 'bag', 'SW1A 1AA', null, null, %L, 'b1', 'Merchant', 'merchant.co.uk', 'SW1 1AA', 'today', 6.75, null, null) $$,
    :'order_id_e', :'current_version_e', :'site_e'),
  'the real requester (worker_e_a) can still edit their own order after the hotfix'
);

select tests.authenticate_as(:'owner_e');
select lives_ok(
  format($$ select approve_order(%L) $$, :'order_id_e'),
  'the real owner can still approve an order after the hotfix'
);
select is(
  (select status::text from orders where id = :'order_id_e'), 'pending_purchase',
  'approval actually took effect — the order moved to pending_purchase'
);

select finish();
rollback;
