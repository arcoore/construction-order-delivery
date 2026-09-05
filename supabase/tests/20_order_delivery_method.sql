-- Order delivery method (migration 0026) — closes the "every order assumes
-- an internal Driver" gap the product audit surfaced. Covers: the
-- delivery_method column/CHECK, create_order's widened (19-arg, default
-- 'driver') signature and its grant integrity (same defense-in-depth class
-- 05_rpc_auth_hardening.sql established for every lifecycle RPC), that an
-- existing 18-positional-arg call still resolves via the new default, that
-- claim_delivery now refuses a direct_supplier order (so it can never enter
-- the driver pool) while remaining unaffected for an ordinary driver order,
-- and the new confirm_direct_delivery RPC's full authorization/state-guard
-- behavior.
begin;
select plan(15);

select tests.create_user('owner-dm@test.local', 'Owner DM')   as owner_dm \gset
select tests.create_user('worker-dm@test.local', 'Worker DM') as worker_dm \gset
select tests.create_user('buyer-dm@test.local', 'Buyer DM')   as buyer_dm \gset
select tests.create_user('driver-dm@test.local', 'Driver DM') as driver_dm \gset

insert into communities (name, invite_code, owner_id, require_owner_approval) values ('DM Co', 'DMCO01', :'owner_dm', false) returning id as co \gset
insert into sites (community_id, name, created_by_id) values (:'co', 'DM Site', :'owner_dm') returning id as site \gset
insert into community_memberships (community_id, user_id, status, decided_by_id) values
  (:'co', :'worker_dm', 'approved', :'owner_dm'),
  (:'co', :'buyer_dm', 'approved', :'owner_dm'),
  (:'co', :'driver_dm', 'approved', :'owner_dm');
insert into site_memberships (site_id, community_id, user_id, added_by_id) values
  (:'site', :'co', :'worker_dm', :'owner_dm'),
  (:'site', :'co', :'buyer_dm', :'owner_dm'),
  (:'site', :'co', :'driver_dm', :'owner_dm');
insert into buyer_grants (community_id, user_id, granted_by_id) values (:'co', :'buyer_dm', :'owner_dm');

-- ================================================================
-- Part A (items 1-4) — column/CHECK constraint and signature integrity.
-- ================================================================

select lives_ok(
  format($$ insert into orders (community_id, site_id, site_name, product_id, product_name, quantity, unit, delivery_postcode, requested_by_id, requested_by) values (%L, %L, 'DM Site', 'p1', 'Test Product', 1, 'each', 'SW1A 1AA', %L, 'Worker DM') $$,
    :'co', :'site', :'worker_dm'),
  'item 1: a plain insert with no delivery_method specified defaults to ''driver'''
);
select ok(
  (select delivery_method = 'driver' from orders where product_id = 'p1' and community_id = :'co'),
  'item 2: the default really is ''driver'', not NULL'
);

select throws_ok(
  format($$ insert into orders (community_id, site_id, site_name, product_id, product_name, quantity, unit, delivery_postcode, requested_by_id, requested_by, delivery_method) values (%L, %L, 'DM Site', 'p1', 'Test Product', 1, 'each', 'SW1A 1AA', %L, 'Worker DM', 'courier') $$,
    :'co', :'site', :'worker_dm'),
  '23514', null,
  'item 3: an invalid delivery_method value is rejected by the CHECK constraint'
);

select ok(
  to_regprocedure('public.create_order(uuid, uuid, text, text, text, numeric, text, text, double precision, double precision, text, text, text, text, text, numeric, text, timestamptz)') is null,
  'item 4: the obsolete 18-arg create_order signature (pre-delivery-method) no longer exists as its own catalog entry'
);

-- ================================================================
-- Part B (items 5-7) — the widened create_order signature, as a real actor.
-- ================================================================
select tests.authenticate_as(:'worker_dm');

select create_order(:'co', :'site', 'p2', 'Cement', null, 5, 'bag', 'SW1A 1AA', null, null, 'b1', 'Merchant', 'merchant.co.uk', 'SW1 1AA', 'today', 6.75, null, null) as omitted_result \gset
select ok(
  (:'omitted_result'::orders).delivery_method = 'driver',
  'item 5: calling create_order with the old 18-argument shape (delivery_method omitted) still works and defaults to ''driver'' — a genuine backward-compatible default, not a breaking change'
);

select create_order(:'co', :'site', 'p3', 'Plasterboard', null, 3, 'sheet', 'SW1A 1AA', null, null, 'b1', 'Merchant', 'merchant.co.uk', 'SW1 1AA', 'today', 9.00, null, null, 'direct_supplier') as direct_result \gset
select ok(
  (:'direct_result'::orders).delivery_method = 'direct_supplier',
  'item 6: create_order accepts and stores an explicit ''direct_supplier'' delivery method'
);
select (:'direct_result'::orders).id as direct_order_id \gset

select throws_ok(
  format($$ select create_order(%L, %L, 'p4', 'Timber', null, 1, 'length', 'SW1A 1AA', null, null, 'b1', 'Merchant', 'merchant.co.uk', 'SW1 1AA', 'today', 12.00, null, null, 'courier') $$,
    :'co', :'site'),
  '22023', null,
  'item 7: create_order rejects an invalid delivery_method value'
);

-- ================================================================
-- Part C (items 8-9) — claim_delivery excludes direct_supplier orders from
-- the driver pool, while remaining unaffected for an ordinary driver order.
-- ================================================================
select tests.authenticate_as(:'buyer_dm');
select start_purchase(:'direct_order_id');
select complete_purchase(:'direct_order_id');

select tests.authenticate_as(:'driver_dm');
select throws_ok(
  format($$ select claim_delivery(%L) $$, :'direct_order_id'),
  '22023', null,
  'item 8: a driver cannot claim a direct_supplier order — it never enters the pool'
);

select tests.authenticate_as(:'buyer_dm');
select id as driver_order_id from orders where product_id = 'p2' and community_id = :'co' \gset
select start_purchase(:'driver_order_id');
select complete_purchase(:'driver_order_id');
select tests.authenticate_as(:'driver_dm');
select claim_delivery(:'driver_order_id');
select ok(
  (select status = 'claimed' and driver_id = :'driver_dm' from orders where id = :'driver_order_id'),
  'item 9: an ordinary ''driver'' order can still be claimed exactly as before — the new guard doesn''t affect the existing path'
);

-- ================================================================
-- Part D (items 10-15) — confirm_direct_delivery authorization and state
-- guards.
-- ================================================================
select throws_ok(
  format($$ select confirm_direct_delivery(%L, now(), 'Site gate') $$, :'driver_order_id'),
  '22023', null,
  'item 10: confirm_direct_delivery refuses an ordinary ''driver'' order even for its purchasing buyer'
);

select tests.authenticate_as(:'driver_dm');
select throws_ok(
  format($$ select confirm_direct_delivery(%L, now(), 'Site gate') $$, :'direct_order_id'),
  '42501', null,
  'item 11: only the buyer who purchased a direct_supplier order may confirm its delivery — not a driver, even though drivers can act elsewhere in this company'
);

select tests.authenticate_as(:'buyer_dm');
select confirm_direct_delivery(:'direct_order_id', now(), 'Site gate') as confirm_result \gset
select ok(
  (:'confirm_result'::orders).status = 'delivered',
  'item 12: the purchasing buyer confirming direct delivery moves the order straight from purchased to delivered — no claimed/collected leg'
);

select ok(
  exists(
    select 1 from order_events
    where order_id = :'direct_order_id' and type = 'delivered'
      and from_status = 'purchased' and to_status = 'delivered'
      and (meta->>'viaDirectSupplier')::boolean = true
  ),
  'item 13: the resulting order_events row correctly records from_status=purchased and meta.viaDirectSupplier=true, distinguishing it from a driver delivery'
);

select tests.authenticate_as(:'worker_dm');
select ok(
  exists(select 1 from notifications where recipient_user_id = :'worker_dm' and order_id = :'direct_order_id' and type = 'order_delivered'),
  'item 14: the requesting worker receives the same order_delivered notification type a driver delivery would have produced'
);

select tests.authenticate_as(:'buyer_dm');
select throws_ok(
  format($$ select confirm_direct_delivery(%L, now(), 'Site gate') $$, :'direct_order_id'),
  '40001', null,
  'item 15: confirming an already-delivered order again is refused (no longer at purchased status)'
);

select finish();
rollback;
