-- Covers audit items 9-16, 18: unauthorized order actions, the claim/
-- purchase races, stale-transition refusal, the cancellation-vs-collection
-- race, and order_events immutability.
--
-- A NOTE ON "RACES": pgTAP runs everything in one file inside a single
-- transaction, so it cannot literally spin up two concurrent connections.
-- What it CAN do — and what these tests do — is prove the conditional
-- UPDATE ... WHERE clause each RPC function relies on is correct: a second
-- sequential call against a row whose status/driver_id has already moved on
-- must fail exactly the same way a genuinely concurrent second call would
-- (Postgres's row-level UPDATE atomicity is what turns "correct WHERE
-- clause" into "safe under real concurrency" — that guarantee comes from
-- the database engine itself, not from anything tested here). A true
-- multi-connection race test is a reasonable later addition once real
-- infrastructure exists to run one (see the Phase 8A report).
begin;
select plan(17);

select tests.create_user('owner-c@test.local', 'Owner C')   as owner_c \gset
select tests.create_user('worker-c@test.local', 'Worker C') as worker_c \gset
select tests.create_user('buyer-c@test.local', 'Buyer C')   as buyer_c \gset
select tests.create_user('driver-1@test.local', 'Driver One') as driver_1 \gset
select tests.create_user('driver-2@test.local', 'Driver Two') as driver_2 \gset
select tests.create_user('stranger@test.local', 'Stranger')   as stranger \gset

select tests.authenticate_as(:'owner_c');
insert into communities (name, invite_code, owner_id) values ('Company C', 'CCCCCC', :'owner_c') returning id as company_c \gset
insert into sites (community_id, name, created_by_id) values (:'company_c', 'Site C', :'owner_c') returning id as site_c \gset

-- Membership approval is a real two-step flow, not a shortcut an owner can
-- take unilaterally — each user requests (pending) for themselves, only
-- then can an owner decide it. Local verification (Phase 8A.5) correctly
-- caught an earlier version of this fixture trying to bulk-insert
-- already-approved rows directly, which the real app never does either.
select tests.authenticate_as(:'worker_c');
insert into community_memberships (community_id, user_id, status) values (:'company_c', :'worker_c', 'pending');
select tests.authenticate_as(:'driver_1');
insert into community_memberships (community_id, user_id, status) values (:'company_c', :'driver_1', 'pending');
select tests.authenticate_as(:'driver_2');
insert into community_memberships (community_id, user_id, status) values (:'company_c', :'driver_2', 'pending');

select tests.authenticate_as(:'owner_c');
update community_memberships set status = 'approved', decided_by_id = :'owner_c'
  where community_id = :'company_c' and user_id in (:'worker_c', :'driver_1', :'driver_2');

insert into site_memberships (site_id, community_id, user_id, added_by_id) values
  (:'site_c', :'company_c', :'worker_c', :'owner_c'),
  (:'site_c', :'company_c', :'buyer_c', :'owner_c');
insert into buyer_grants (community_id, user_id, granted_by_id) values (:'company_c', :'buyer_c', :'owner_c');

-- ---------------------------------------------------- 9: unauthorized order creation
select tests.authenticate_as(:'stranger');
select throws_ok(
  format($$ select create_order(%L, %L, 'p1', 'Cement', '25kg', 5, 'bag', 'SW1A 1AA', null, null, 'b1', 'Merchant', 'merchant.co.uk', 'SW1 1AA', 'today', 6.75) $$,
    :'company_c', :'site_c'),
  '42501', null,
  'a stranger with no site membership cannot create an order (item 9)'
);

select tests.authenticate_as(:'worker_c');
select create_order(:'company_c', :'site_c', 'p1', 'Cement', '25kg', 5, 'bag', 'SW1A 1AA', null, null, 'b1', 'Merchant', 'merchant.co.uk', 'SW1 1AA', 'today', 6.75) as order_result \gset
select ok( (:'order_result') is not null, 'worker C, a real site member, can create an order' );
select (:'order_result'::orders).id as order_id \gset

-- ---------------------------------------------------- 10: unauthorized approval
select tests.authenticate_as(:'stranger');
select throws_ok(
  format($$ select approve_order(%L) $$, :'order_id'), '42501', null,
  'a stranger cannot approve an order (item 10)'
);
select tests.authenticate_as(:'worker_c');
select throws_ok(
  format($$ select approve_order(%L) $$, :'order_id'), '42501', null,
  'the requesting worker themselves cannot approve their own order'
);
select tests.authenticate_as(:'owner_c');
select approve_order(:'order_id');
select is( (select status from orders where id = :'order_id')::text, 'pending_purchase', 'owner approval succeeds and advances status' );

-- ---------------------------------------------------- 11: unauthorized purchase
select tests.authenticate_as(:'stranger');
select throws_ok(
  format($$ select start_purchase(%L) $$, :'order_id'), '42501', null,
  'a stranger cannot start a purchase (item 11)'
);
select tests.authenticate_as(:'buyer_c');
select start_purchase(:'order_id');
select complete_purchase(:'order_id');
select is( (select status from orders where id = :'order_id')::text, 'purchased', 'authorized buyer completes the purchase' );

-- ---------------------------------------------------- 14: double buyer purchase-start (sequential proof of the WHERE guard)
select tests.create_user('buyer-c2@test.local', 'Buyer C2') as buyer_c2 \gset
select tests.authenticate_as(:'buyer_c2');
insert into community_memberships (community_id, user_id, status) values (:'company_c', :'buyer_c2', 'pending');
select tests.authenticate_as(:'owner_c');
update community_memberships set status = 'approved', decided_by_id = :'owner_c'
  where community_id = :'company_c' and user_id = :'buyer_c2';
insert into site_memberships (site_id, community_id, user_id, added_by_id) values (:'site_c', :'company_c', :'buyer_c2', :'owner_c');
insert into buyer_grants (community_id, user_id, granted_by_id) values (:'company_c', :'buyer_c2', :'owner_c');

select tests.authenticate_as(:'worker_c');
select create_order(:'company_c', :'site_c', 'p2', 'Sand', '25kg', 3, 'bag', 'SW1A 1AA', null, null, 'b1', 'Merchant', 'merchant.co.uk', 'SW1 1AA', 'today', 4.50) as order2_result \gset
select (:'order2_result'::orders).id as order2_id \gset
select tests.authenticate_as(:'owner_c');
select approve_order(:'order2_id');

select tests.authenticate_as(:'buyer_c');
select start_purchase(:'order2_id');
select tests.authenticate_as(:'buyer_c2');
select throws_ok(
  format($$ select start_purchase(%L) $$, :'order2_id'), '40001', null,
  'a second buyer cannot also start purchasing the same order (item 14)'
);

-- ---------------------------------------------------- 12/13: unauthorized/racing delivery claim
select tests.authenticate_as(:'buyer_c');
select complete_purchase(:'order2_id');

select tests.authenticate_as(:'stranger');
select throws_ok(
  format($$ select claim_delivery(%L) $$, :'order2_id'), '42501', null,
  'a stranger (not even a company member) cannot claim a delivery (item 12)'
);

select tests.authenticate_as(:'driver_1');
select claim_delivery(:'order2_id');
select tests.authenticate_as(:'driver_2');
select throws_ok(
  format($$ select claim_delivery(%L) $$, :'order2_id'), '40001', null,
  'a second driver cannot also claim the same delivery (item 13)'
);
-- Checked as owner_c, not driver_2: once claimed, this order correctly
-- disappears from driver_2's own RLS visibility entirely (they're not the
-- assigned driver, not a site member, not the owner) — the losing driver
-- genuinely cannot see it anymore, which is correct pool behavior, not a
-- bug. An earlier version of this test checked as driver_2 and got zero
-- rows back for exactly that reason.
select tests.authenticate_as(:'owner_c');
select is( (select driver_id from orders where id = :'order2_id'), :'driver_1'::uuid,
  'exactly the first driver ends up assigned' );

-- ---------------------------------------------------- 15: stale transition refusal
select tests.authenticate_as(:'driver_1');
select mark_collected(:'order2_id');
select throws_ok(
  format($$ select mark_collected(%L) $$, :'order2_id'), '40001', null,
  'marking an already-collected order collected again is refused, not silently re-applied (item 15)'
);

-- ---------------------------------------------------- 16: cancellation decision vs collection race
select tests.authenticate_as(:'worker_c');
select create_order(:'company_c', :'site_c', 'p3', 'Drill', 'Body only', 1, 'each', 'SW1A 1AA', null, null, 'b1', 'Merchant', 'merchant.co.uk', 'SW1 1AA', 'today', 89.00) as order3_result \gset
select (:'order3_result'::orders).id as order3_id \gset
select tests.authenticate_as(:'owner_c');
select approve_order(:'order3_id');
select tests.authenticate_as(:'buyer_c');
select start_purchase(:'order3_id');
select complete_purchase(:'order3_id');
select tests.authenticate_as(:'driver_2');
select claim_delivery(:'order3_id');

select tests.authenticate_as(:'worker_c');
select request_cancellation(:'order3_id', 'Wrong item') as request_result \gset
select (:'request_result'::cancellation_requests).id as request3_id \gset

-- driver collects BEFORE the buyer decides
select tests.authenticate_as(:'driver_2');
select mark_collected(:'order3_id');

select tests.authenticate_as(:'buyer_c');
select decide_cancellation_request(:'request3_id', 'approved', 'Approving late') as decision \gset
select is( (:'decision'::jsonb) ->> 'autoClosed', 'true',
  'a decision that arrives after collection is safely auto-closed, not silently approved (item 16)' );
select is( (select status from orders where id = :'order3_id')::text, 'collected',
  'the order itself is untouched — still collected, never falsely cancelled (item 16)' );
select is( (select status from cancellation_requests where id = :'request3_id')::text, 'rejected',
  'the request is deterministically closed as rejected, not left pending forever (item 16)' );

-- ---------------------------------------------------- 18: order_events immutability
select tests.authenticate_as(:'owner_c');
select throws_ok(
  format($$ update order_events set reason = 'tampered' where order_id = %L $$, :'order_id'),
  '42501', null,
  'even the community owner cannot UPDATE an existing order_events row (item 18)'
);
select throws_ok(
  format($$ delete from order_events where order_id = %L $$, :'order_id'),
  '42501', null,
  'even the community owner cannot DELETE an order_events row (item 18)'
);

select finish();
rollback;
