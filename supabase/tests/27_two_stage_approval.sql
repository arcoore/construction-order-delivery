-- Value-threshold second approval (migration 0034). An order over
-- communities.approval_threshold needs two approvals from two different
-- owners; at/under it, one approval as before.
begin;
select plan(16);

select tests.create_user('owner-ta@test.local', 'Owner TA')   as owner_ta \gset
select tests.create_user('owner2-ta@test.local', 'Owner2 TA')  as owner2_ta \gset
select tests.create_user('worker-ta@test.local', 'Worker TA')  as worker_ta \gset

insert into communities (name, invite_code, owner_id, require_owner_approval, approval_threshold)
  values ('TA Co', 'TACO01', :'owner_ta', true, 100) returning id as co \gset
insert into sites (community_id, name, created_by_id) values (:'co', 'TA Site', :'owner_ta') returning id as site \gset
insert into community_memberships (community_id, user_id, status, decided_by_id) values
  (:'co', :'owner2_ta', 'approved', :'owner_ta'),
  (:'co', :'worker_ta', 'approved', :'owner_ta');
insert into site_memberships (site_id, community_id, user_id, added_by_id) values (:'site', :'co', :'worker_ta', :'owner_ta');

-- creator grants owner access to owner2
select tests.authenticate_as(:'owner_ta');
insert into owner_grants (community_id, user_id, granted_by_id) values (:'co', :'owner2_ta', :'owner_ta');

select tests.authenticate_as(:'worker_ta');

-- ---- under threshold: one approval clears it ----
select tests.create_order_1(:'co', :'site', 'p1', 'Cement', '25kg', 5, 'bag', 'SW1A 1AA', null, null, 'b1', 'M', 'm.co.uk', 'SW1 1AA', 'today', 10.00, null, null) as small \gset
select (:'small'::orders).id as small_id \gset
select is((:'small'::orders).needs_second_approval, false, 'item 1: a £50 order (under the £100 threshold) does not need a second approval');
select is((:'small'::orders).status::text, 'pending_approval', 'item 2: it still starts at pending_approval (approval is on)');

select tests.authenticate_as(:'owner_ta');
select approve_order(:'small_id');
select is((select status from orders where id = :'small_id')::text, 'pending_purchase', 'item 3: one owner approval sends the under-threshold order straight to pending_purchase');

-- ---- over threshold: needs two approvals ----
select tests.authenticate_as(:'worker_ta');
select tests.create_order_1(:'co', :'site', 'p2', 'Steel', 'RSJ', 15, 'length', 'SW1A 1AA', null, null, 'b1', 'M', 'm.co.uk', 'SW1 1AA', 'today', 10.00, null, null) as big \gset
select (:'big'::orders).id as big_id \gset
select is((:'big'::orders).needs_second_approval, true, 'item 4: a £150 order (over the £100 threshold) needs a second approval');

select tests.authenticate_as(:'owner_ta');
select approve_order(:'big_id');
select is((select status from orders where id = :'big_id')::text, 'pending_approval', 'item 5: after the first approval it stays at pending_approval');
select is((select approved_by_id from orders where id = :'big_id'), :'owner_ta'::uuid, 'item 6: the first approver is recorded');
select is((select second_approved_by_id from orders where id = :'big_id') is null, true, 'item 7: no second approver yet');

-- same owner cannot give the second approval
select throws_ok(
  format($$ select approve_order(%L) $$, :'big_id'),
  '42501', null,
  'item 8: the same owner cannot also give the second approval'
);

-- a non-owner cannot approve
select tests.authenticate_as(:'worker_ta');
select throws_ok(
  format($$ select approve_order(%L) $$, :'big_id'),
  '42501', null,
  'item 9: a non-owner still cannot approve'
);

-- the second owner completes it
select tests.authenticate_as(:'owner2_ta');
select approve_order(:'big_id');
select is((select status from orders where id = :'big_id')::text, 'pending_purchase', 'item 10: the second owner''s approval sends it to pending_purchase');
select is((select second_approved_by_id from orders where id = :'big_id'), :'owner2_ta'::uuid, 'item 11: the second approver is recorded');

-- two 'approved' events, stage first + second
select is(
  (select count(*) from order_events where order_id = :'big_id' and type = 'approved')::int, 2,
  'item 12: two approved events were logged'
);
select is(
  (select count(distinct meta->>'stage')::int from order_events
   where order_id = :'big_id' and type = 'approved' and meta->>'stage' in ('first', 'second')), 2,
  'item 13: both a stage=first and a stage=second approved event exist'
);

-- revert clears both approvals
select tests.authenticate_as(:'owner_ta');
select revert_approval(:'big_id');
select is(
  (select approved_by_id is null and second_approved_by_id is null from orders where id = :'big_id'), true,
  'item 14: revert clears both the first and second approval'
);

-- editing the big order down under the threshold drops the second-approval requirement
select tests.authenticate_as(:'worker_ta');
select version as bv from orders where id = :'big_id' \gset
select edit_order(:'big_id', :'bv'::integer,
  jsonb_build_array(jsonb_build_object('productId','p2','productName','Steel','variant','RSJ','quantity',3,'unit','length','unitPrice',10.00)),
  'SW1A 1AA', null, null, :'site', 'b1', 'M', 'm.co.uk', 'SW1 1AA', 'today', null, null);
select is((select needs_second_approval from orders where id = :'big_id'), false,
  'item 15: editing the order down to £30 removes the second-approval requirement');

-- growing an approved small order back over the threshold restores it
select version as sv from orders where id = :'small_id' \gset
select edit_order(:'small_id', :'sv'::integer,
  jsonb_build_array(jsonb_build_object('productId','p1','productName','Cement','variant','25kg','quantity',20,'unit','bag','unitPrice',10.00)),
  'SW1A 1AA', null, null, :'site', 'b1', 'M', 'm.co.uk', 'SW1 1AA', 'today', null, null);
select is(
  (select needs_second_approval and status::text = 'pending_approval' and approved_by_id is null from orders where id = :'small_id'), true,
  'item 16: growing an approved order to £200 forces re-approval AND now needs two');

select finish();
rollback;
