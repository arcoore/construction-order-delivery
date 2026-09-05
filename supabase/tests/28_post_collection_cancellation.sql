-- Post-collection cancellation (migration 0035). A cancellation can now be
-- requested at 'collected'; approving it cancels the order and notifies the
-- driver to arrange the return. 'delivered' stays non-cancellable and a
-- decision that lands after delivery auto-closes.
begin;
select plan(11);

select tests.create_user('owner-pc@test.local', 'Owner PC')   as owner_pc \gset
select tests.create_user('worker-pc@test.local', 'Worker PC') as worker_pc \gset
select tests.create_user('buyer-pc@test.local', 'Buyer PC')   as buyer_pc \gset
select tests.create_user('driver-pc@test.local', 'Driver PC') as driver_pc \gset

insert into communities (name, invite_code, owner_id, require_owner_approval)
  values ('PC Co', 'PCCO01', :'owner_pc', false) returning id as co \gset
insert into sites (community_id, name, created_by_id) values (:'co', 'PC Site', :'owner_pc') returning id as site \gset
insert into community_memberships (community_id, user_id, status, decided_by_id) values
  (:'co', :'worker_pc', 'approved', :'owner_pc'),
  (:'co', :'buyer_pc', 'approved', :'owner_pc'),
  (:'co', :'driver_pc', 'approved', :'owner_pc');
insert into site_memberships (site_id, community_id, user_id, added_by_id) values
  (:'site', :'co', :'worker_pc', :'owner_pc'),
  (:'site', :'co', :'buyer_pc', :'owner_pc');
insert into buyer_grants (community_id, user_id, granted_by_id) values (:'co', :'buyer_pc', :'owner_pc');

-- helper: an order collected by the driver
select tests.authenticate_as(:'worker_pc');
select tests.create_order_1(:'co', :'site', 'p1', 'Cement', '25kg', 5, 'bag', 'SW1A 1AA', null, null, 'b1', 'M', 'm.co.uk', 'SW1 1AA', 'today', 10.00, null, null) as o1 \gset
select (:'o1'::orders).id as o1_id \gset
select tests.authenticate_as(:'buyer_pc');
select start_purchase(:'o1_id'); select complete_purchase(:'o1_id');
select tests.authenticate_as(:'driver_pc');
select claim_delivery(:'o1_id'); select mark_collected(:'o1_id');

-- item 1: worker can request cancellation of a collected order
select tests.authenticate_as(:'worker_pc');
select request_cancellation(:'o1_id', 'Site flooded, send it back') as req1 \gset
select is((:'req1'::cancellation_requests).status::text, 'pending', 'item 1: a collected order accepts a cancellation request');
select (:'req1'::cancellation_requests).id as req1_id \gset

-- item 2: the buyer's cancellation-requested notification flags it as collected
select tests.authenticate_as(:'buyer_pc');
select ok(
  exists(select 1 from notifications where recipient_user_id = :'buyer_pc' and type = 'cancellation_requested'
    and order_id = :'o1_id' and message like '%already collected%'),
  'item 2: the buyer notification says the order was already collected'
);

-- item 3-6: buyer approves -> order cancelled, driver + worker notified
select decide_cancellation_request(:'req1_id', 'approved', 'Agreed') as d1 \gset
select is((:'d1'::jsonb)->>'result', 'cancelled', 'item 3: approving a collected order''s cancellation returns result=cancelled');
select is((select status from orders where id = :'o1_id')::text, 'cancelled', 'item 4: the order is now cancelled');
select is((select driver_id from orders where id = :'o1_id') is null, true, 'item 5: the driver is cleared off the order');
select is(
  (select (meta->>'wasCollected')::boolean from order_events where order_id = :'o1_id' and type = 'order_cancelled'),
  true, 'item 6: the order_cancelled event records wasCollected=true');

select tests.authenticate_as(:'driver_pc');
select ok(
  exists(select 1 from notifications where recipient_user_id = :'driver_pc' and order_id = :'o1_id'
    and message like '%arrange the return%'),
  'item 7: the driver is told to arrange the return with the supplier'
);
select tests.authenticate_as(:'worker_pc');
select ok(
  exists(select 1 from notifications where recipient_user_id = :'worker_pc' and type = 'cancellation_approved'
    and order_id = :'o1_id' and message like '%arrange the return%'),
  'item 8: the requester''s approval notification mentions the return too'
);

-- item 9: a delivered order cannot have a cancellation requested
select tests.create_order_1(:'co', :'site', 'p2', 'Sand', 'bulk', 2, 'bag', 'SW1A 1AA', null, null, 'b1', 'M', 'm.co.uk', 'SW1 1AA', 'today', 10.00, null, null) as o2 \gset
select (:'o2'::orders).id as o2_id \gset
select tests.authenticate_as(:'buyer_pc');
select start_purchase(:'o2_id'); select complete_purchase(:'o2_id');
select tests.authenticate_as(:'driver_pc');
select claim_delivery(:'o2_id'); select mark_collected(:'o2_id');
select mark_delivered(:'o2_id', now(), 'Site gate');
select tests.authenticate_as(:'worker_pc');
select throws_ok(
  format($$ select request_cancellation(%L, 'too late') $$, :'o2_id'),
  '42501', null,
  'item 9: a delivered order rejects a cancellation request'
);

-- item 10-11: a request made at collected, then delivered before the decision, auto-closes
select tests.create_order_1(:'co', :'site', 'p3', 'Nails', '50mm', 1, 'box', 'SW1A 1AA', null, null, 'b1', 'M', 'm.co.uk', 'SW1 1AA', 'today', 5.00, null, null) as o3 \gset
select (:'o3'::orders).id as o3_id \gset
select tests.authenticate_as(:'buyer_pc');
select start_purchase(:'o3_id'); select complete_purchase(:'o3_id');
select tests.authenticate_as(:'driver_pc');
select claim_delivery(:'o3_id'); select mark_collected(:'o3_id');
select tests.authenticate_as(:'worker_pc');
select request_cancellation(:'o3_id', 'changed mind') as req3 \gset
select (:'req3'::cancellation_requests).id as req3_id \gset
select tests.authenticate_as(:'driver_pc');
select mark_delivered(:'o3_id', now(), 'Site gate');
select tests.authenticate_as(:'buyer_pc');
select decide_cancellation_request(:'req3_id', 'approved', 'late') as d3 \gset
select is((:'d3'::jsonb)->>'autoClosed', 'true', 'item 10: a decision landing after delivery auto-closes');
select is((select status from orders where id = :'o3_id')::text, 'delivered', 'item 11: the delivered order is untouched');

select finish();
rollback;
