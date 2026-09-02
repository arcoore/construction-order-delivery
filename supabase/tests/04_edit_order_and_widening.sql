-- Phase 8C — coverage for the widened edit_order (migration 0012).
--
-- NOTE ON SCOPE: the Phase 8C plan proposed three new race tests (buyer-vs-
-- buyer purchase, worker-edit-vs-owner-approval, driver-collect-vs-
-- cancellation-decision). Checking the existing suite before writing new
-- tests found that two of those three are ALREADY covered:
--   - buyer-vs-buyer start_purchase race: 02_order_lifecycle_and_races.sql,
--     item 14 ("a second buyer cannot also start purchasing the same order").
--   - driver-collect-vs-cancellation-decision race: same file, item 16
--     ("a decision that arrives after collection is safely auto-closed").
-- Adding near-duplicates of those would pad the count without adding real
-- coverage. What genuinely had ZERO test coverage — not just the race case,
-- the function generally — was edit_order itself: grepping supabase/tests/
-- for "edit_order" before this file existed returned nothing, despite it
-- being the exact function this migration widened. This file prioritizes
-- closing that real gap over hitting an exact pre-committed test count; see
-- the Phase 8C implementation report for the honest total.
begin;
select plan(9);

select tests.create_user('owner-d@test.local', 'Owner D')   as owner_d \gset
select tests.create_user('worker-d@test.local', 'Worker D') as worker_d \gset
select tests.create_user('stranger-d@test.local', 'Stranger D') as stranger_d \gset

select tests.authenticate_as(:'owner_d');
insert into communities (name, invite_code, owner_id) values ('Company D', 'DDDDDD', :'owner_d') returning id as company_d \gset
insert into sites (community_id, name, created_by_id) values (:'company_d', 'Site D', :'owner_d') returning id as site_d \gset
insert into sites (community_id, name, created_by_id) values (:'company_d', 'Site D2', :'owner_d') returning id as site_d2 \gset

select tests.authenticate_as(:'worker_d');
insert into community_memberships (community_id, user_id, status) values (:'company_d', :'worker_d', 'pending');
select tests.set_membership_status(:'company_d', :'worker_d', 'approved', :'owner_d');
select tests.authenticate_as(:'owner_d');
insert into site_memberships (site_id, community_id, user_id, added_by_id) values
  (:'site_d', :'company_d', :'worker_d', :'owner_d'),
  (:'site_d2', :'company_d', :'worker_d', :'owner_d');

-- ---------------------------------------------------- fixture order
select tests.authenticate_as(:'worker_d');
select create_order(:'company_d', :'site_d', 'p1', 'Cement', '25kg bag', 5, 'bag', 'SW1A 1AA', null, null, 'b1', 'Merchant', 'merchant.co.uk', 'SW1 1AA', 'today', 6.75, null, null) as order_result \gset
select (:'order_result'::orders).id as order_id \gset
select (:'order_result'::orders).version as order_version \gset

-- ---------------------------------------------------- 1: unauthorized edit
select tests.authenticate_as(:'stranger_d');
select throws_ok(
  format($$ select edit_order(%L, %L, 'p1', 'Cement', '25kg bag', 9, 'bag', 'SW1A 1AA', null, null, %L, 'b1', 'Merchant', 'merchant.co.uk', 'SW1 1AA', 'today', 6.75, null, null) $$,
    :'order_id', :'order_version', :'site_d'),
  '42501', null,
  'a non-requester cannot edit this order'
);

-- ---------------------------------------------------- 2: successful edit recomputes total_price server-side
select tests.authenticate_as(:'worker_d');
select edit_order(:'order_id', :'order_version', 'p1', 'Cement', '25kg bag', 9, 'bag', 'SW1A 1AA', null, null, :'site_d', 'b1', 'Merchant', 'merchant.co.uk', 'SW1 1AA', 'today', 6.75, null, null) as edit_result \gset
select is( (:'edit_result'::orders).total_price, 60.75::numeric,
  'total_price is server-recomputed as unit_price * new quantity (9 * 6.75), never trusted from the caller' );
select is( (:'edit_result'::orders).version, (:'order_version'::integer) + 1,
  'a successful edit increments version' );

-- ---------------------------------------------------- 3: no-op edit refused
select tests.authenticate_as(:'worker_d');
select (:'edit_result'::orders).version as order_version2 \gset
select throws_ok(
  format($$ select edit_order(%L, %L, 'p1', 'Cement', '25kg bag', 9, 'bag', 'SW1A 1AA', null, null, %L, 'b1', 'Merchant', 'merchant.co.uk', 'SW1 1AA', 'today', 6.75, null, null) $$,
    :'order_id', :'order_version2', :'site_d'),
  '22023', null,
  'resubmitting identical values is refused as a no-op edit, matching the prototype editOrder() behavior'
);

-- ---------------------------------------------------- 4: edit forces reapproval once approved
select tests.authenticate_as(:'owner_d');
select approve_order(:'order_id');
select tests.authenticate_as(:'worker_d');
select (select version from orders where id = :'order_id') as approved_version \gset
select edit_order(:'order_id', :'approved_version', 'p1', 'Cement', '25kg bag', 12, 'bag', 'SW1A 1AA', null, null, :'site_d', 'b1', 'Merchant', 'merchant.co.uk', 'SW1 1AA', 'today', 6.75, null, null) as reapprove_result \gset
select is( (:'reapprove_result'::orders).status::text, 'pending_approval',
  'editing an already-approved order resets it to pending_approval' );
select is( (:'reapprove_result'::orders).approved_by_id, null,
  'the prior approval is cleared, not silently carried over onto the edited version' );
select ok(
  exists(select 1 from order_events where order_id = :'order_id' and type = 'approval_reverted'),
  'an approval_reverted event is appended alongside order_edited, exactly mirroring the owner''s own manual revert'
);

-- ---------------------------------------------------- 5: stale version conflict (worker edit racing owner approval)
-- Simulates the Worker holding a stale copy of the order (from before the
-- Owner's own action above bumped version) and submitting an edit against
-- it — the exact "Worker edits while Owner approves" scenario from the
-- approved Phase 8C architecture plan.
select tests.authenticate_as(:'worker_d');
select throws_ok(
  format($$ select edit_order(%L, %L, 'p1', 'Cement', '25kg bag', 20, 'bag', 'SW1A 1AA', null, null, %L, 'b1', 'Merchant', 'merchant.co.uk', 'SW1 1AA', 'today', 6.75, null, null) $$,
    :'order_id', :'order_version', :'site_d'),  -- deliberately the ORIGINAL, now-stale version
  '40001', null,
  'an edit submitted against a stale version is refused, not silently applied over a newer server state'
);

-- ---------------------------------------------------- 6: negative unit_price rejected
select tests.authenticate_as(:'worker_d');
select (select version from orders where id = :'order_id') as current_version \gset
select throws_ok(
  format($$ select edit_order(%L, %L, 'p1', 'Cement', '25kg bag', 5, 'bag', 'SW1A 1AA', null, null, %L, 'b1', 'Merchant', 'merchant.co.uk', 'SW1 1AA', 'today', -1, null, null) $$,
    :'order_id', :'current_version', :'site_d'),
  '23514', null,
  'a negative unit_price is refused by the server-side non-negative check constraint, regardless of what the browser sends'
);

select finish();
rollback;
