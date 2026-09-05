-- Partial fulfilment reporting (migration 0036). The driver may flag line
-- items short on delivery; the order still completes, fulfilment_status
-- records full vs partial, flagged order_items carry delivered_short + note.
begin;
select plan(12);

select tests.create_user('owner-pf@test.local', 'Owner PF')   as owner_pf \gset
select tests.create_user('worker-pf@test.local', 'Worker PF') as worker_pf \gset
select tests.create_user('buyer-pf@test.local', 'Buyer PF')   as buyer_pf \gset
select tests.create_user('driver-pf@test.local', 'Driver PF') as driver_pf \gset

insert into communities (name, invite_code, owner_id, require_owner_approval)
  values ('PF Co', 'PFCO01', :'owner_pf', false) returning id as co \gset
insert into sites (community_id, name, created_by_id) values (:'co', 'PF Site', :'owner_pf') returning id as site \gset
insert into community_memberships (community_id, user_id, status, decided_by_id) values
  (:'co', :'worker_pf', 'approved', :'owner_pf'),
  (:'co', :'buyer_pf', 'approved', :'owner_pf'),
  (:'co', :'driver_pf', 'approved', :'owner_pf');
insert into site_memberships (site_id, community_id, user_id, added_by_id) values
  (:'site', :'co', :'worker_pf', :'owner_pf'),
  (:'site', :'co', :'buyer_pf', :'owner_pf');
insert into buyer_grants (community_id, user_id, granted_by_id) values (:'co', :'buyer_pf', :'owner_pf');

-- a two-item order, taken to 'collected'
select tests.authenticate_as(:'worker_pf');
select create_order(:'co', :'site',
  jsonb_build_array(
    jsonb_build_object('productId','p1','productName','Cement','variant','25kg','quantity',10,'unit','bag','unitPrice',10.00),
    jsonb_build_object('productId','p2','productName','Sand','variant','bulk','quantity',4,'unit','bag','unitPrice',5.00)
  ),
  'SW1A 1AA', null, null, 'b1', 'M', 'm.co.uk', 'SW1 1AA', 'today', null, null) as o1 \gset
select (:'o1'::orders).id as o1_id \gset
select tests.authenticate_as(:'buyer_pf');
select start_purchase(:'o1_id'); select complete_purchase(:'o1_id');
select tests.authenticate_as(:'driver_pf');
select claim_delivery(:'o1_id'); select mark_collected(:'o1_id');

select id as sand_id from order_items where order_id = :'o1_id' and product_name = 'Sand' \gset
select id as cement_id from order_items where order_id = :'o1_id' and product_name = 'Cement' \gset

-- deliver, flagging the Sand short
select mark_delivered(:'o1_id', now(), 'Site gate',
  jsonb_build_array(jsonb_build_object('itemId', :'sand_id', 'note', 'Only 2 of 4 bags on the truck'))) as d1 \gset

select is((:'d1'::orders).status::text, 'delivered', 'item 1: the order still completes as delivered');
select is((:'d1'::orders).fulfilment_status, 'partial', 'item 2: fulfilment_status is partial');
select is((select delivered_short from order_items where id = :'sand_id'), true, 'item 3: the flagged item is marked short');
select is((select shortfall_note from order_items where id = :'sand_id'), 'Only 2 of 4 bags on the truck', 'item 4: the shortfall note is stored');
select is((select delivered_short from order_items where id = :'cement_id'), false, 'item 5: the un-flagged item is not marked short');

select is(
  (select meta->>'fulfilmentStatus' from order_events where order_id = :'o1_id' and type = 'delivered'), 'partial',
  'item 6: the delivered event records fulfilmentStatus=partial');
select is(
  (select (meta->>'shortItemCount')::int from order_events where order_id = :'o1_id' and type = 'delivered'), 1,
  'item 7: the delivered event records shortItemCount=1');

select tests.authenticate_as(:'worker_pf');
select ok(
  exists(select 1 from notifications where recipient_user_id = :'worker_pf' and type = 'order_delivered'
    and order_id = :'o1_id' and message like '%partial%'),
  'item 8: the delivery notification says it was partial'
);

-- a second order delivered in full
select tests.authenticate_as(:'worker_pf');
select tests.create_order_1(:'co', :'site', 'p3', 'Nails', '50mm', 2, 'box', 'SW1A 1AA', null, null, 'b1', 'M', 'm.co.uk', 'SW1 1AA', 'today', 3.00, null, null) as o2 \gset
select (:'o2'::orders).id as o2_id \gset
select tests.authenticate_as(:'buyer_pf');
select start_purchase(:'o2_id'); select complete_purchase(:'o2_id');
select tests.authenticate_as(:'driver_pf');
select claim_delivery(:'o2_id'); select mark_collected(:'o2_id');
select mark_delivered(:'o2_id', now(), 'Site gate') as d2 \gset
select is((:'d2'::orders).fulfilment_status, 'full', 'item 9: a delivery with no shortfalls is fulfilment_status=full');

-- item 10: a shortfall referencing an item from another order is ignored
select tests.authenticate_as(:'worker_pf');
select tests.create_order_1(:'co', :'site', 'p4', 'Timber', '2.4m', 3, 'length', 'SW1A 1AA', null, null, 'b1', 'M', 'm.co.uk', 'SW1 1AA', 'today', 8.00, null, null) as o3 \gset
select (:'o3'::orders).id as o3_id \gset
select tests.authenticate_as(:'buyer_pf');
select start_purchase(:'o3_id'); select complete_purchase(:'o3_id');
select tests.authenticate_as(:'driver_pf');
select claim_delivery(:'o3_id'); select mark_collected(:'o3_id');
select mark_delivered(:'o3_id', now(), 'Site gate',
  jsonb_build_array(jsonb_build_object('itemId', :'cement_id', 'note', 'wrong order'))) as d3 \gset
select is((:'d3'::orders).fulfilment_status, 'full', 'item 10: a shortfall pointing at another order''s item has no effect');
select is((select delivered_short from order_items where id = :'cement_id'), false,
  'item 11: the cement item (never flagged, in a different order) is untouched by the cross-order shortfall');

-- item 12: p_shortfalls must be an array
select tests.authenticate_as(:'worker_pf');
select tests.create_order_1(:'co', :'site', 'p5', 'Screws', '4x40', 1, 'box', 'SW1A 1AA', null, null, 'b1', 'M', 'm.co.uk', 'SW1 1AA', 'today', 2.00, null, null) as o4 \gset
select (:'o4'::orders).id as o4_id \gset
select tests.authenticate_as(:'buyer_pf');
select start_purchase(:'o4_id'); select complete_purchase(:'o4_id');
select tests.authenticate_as(:'driver_pf');
select claim_delivery(:'o4_id'); select mark_collected(:'o4_id');
select throws_ok(
  format($$ select mark_delivered(%L, now(), 'Site gate', '{"not":"an array"}'::jsonb) $$, :'o4_id'),
  '22023', null,
  'item 12: a non-array p_shortfalls is rejected'
);

select finish();
rollback;
