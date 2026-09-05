-- Photo proof of delivery (migration 0039). add_delivery_photo: assigned
-- driver only, collected/delivered only, path under the order's folder.
-- delivery_photos select RLS = can see the order. (Storage.objects policies
-- are exercised manually — pgTAP can't drive the Storage API.)
begin;
select plan(11);

select tests.create_user('owner-dp2@test.local', 'Owner DP2')   as owner_dp \gset
select tests.create_user('worker-dp2@test.local', 'Worker DP2') as worker_dp \gset
select tests.create_user('buyer-dp2@test.local', 'Buyer DP2')   as buyer_dp \gset
select tests.create_user('driver-dp2@test.local', 'Driver DP2') as driver_dp \gset
select tests.create_user('stranger-dp2@test.local', 'Stranger DP2') as stranger_dp \gset

insert into communities (name, invite_code, owner_id, require_owner_approval)
  values ('DP2 Co', 'DP2CO1', :'owner_dp', false) returning id as co \gset
insert into sites (community_id, name, created_by_id) values (:'co', 'DP2 Site', :'owner_dp') returning id as site \gset
insert into community_memberships (community_id, user_id, status, decided_by_id) values
  (:'co', :'worker_dp', 'approved', :'owner_dp'),
  (:'co', :'buyer_dp', 'approved', :'owner_dp'),
  (:'co', :'driver_dp', 'approved', :'owner_dp'),
  (:'co', :'stranger_dp', 'approved', :'owner_dp');
insert into site_memberships (site_id, community_id, user_id, added_by_id) values
  (:'site', :'co', :'worker_dp', :'owner_dp'),
  (:'site', :'co', :'buyer_dp', :'owner_dp');
insert into buyer_grants (community_id, user_id, granted_by_id) values (:'co', :'buyer_dp', :'owner_dp');

select tests.authenticate_as(:'worker_dp');
select tests.create_order_1(:'co', :'site', 'p1', 'Cement', '25kg', 5, 'bag', 'SW1A 1AA', null, null, 'b1', 'M', 'm.co.uk', 'SW1 1AA', 'today', 10.00, null, null) as o1 \gset
select (:'o1'::orders).id as o1_id \gset
select tests.authenticate_as(:'buyer_dp');
select start_purchase(:'o1_id'); select complete_purchase(:'o1_id');
select tests.authenticate_as(:'driver_dp');
select claim_delivery(:'o1_id');

-- item 1: can't add a photo before collection
select throws_ok(
  format($$ select add_delivery_photo(%L, %L) $$, :'o1_id', :'o1_id' || '/x.jpg'),
  '42501', null, 'item 1: no photo before the order is collected'
);

select mark_collected(:'o1_id');

-- item 2: the assigned driver can add a photo once collected
select (add_delivery_photo(:'o1_id', :'o1_id' || '/photo1.jpg')).id as p1 \gset
select ok(:'p1' is not null, 'item 2: the assigned driver adds a photo at collected');

-- item 3: path must be under the order's own folder
select throws_ok(
  format($$ select add_delivery_photo(%L, 'some-other-order/evil.jpg') $$, :'o1_id'),
  '22023', null, 'item 3: a path outside the order folder is rejected'
);

-- item 4: a non-driver cannot add a photo
select tests.authenticate_as(:'worker_dp');
select throws_ok(
  format($$ select add_delivery_photo(%L, %L) $$, :'o1_id', :'o1_id' || '/w.jpg'),
  '42501', null, 'item 4: the requester (not the driver) cannot add a photo'
);
select tests.authenticate_as(:'owner_dp');
select throws_ok(
  format($$ select add_delivery_photo(%L, %L) $$, :'o1_id', :'o1_id' || '/o.jpg'),
  '42501', null, 'item 5: an owner (not the driver) cannot add a photo'
);

-- item 6-9: everyone who can see the order sees the photo row
select tests.authenticate_as(:'owner_dp');
select is((select count(*) from delivery_photos where order_id = :'o1_id')::int, 1, 'item 6: owner sees the photo');
select tests.authenticate_as(:'worker_dp');
select is((select count(*) from delivery_photos where order_id = :'o1_id')::int, 1, 'item 7: requester sees the photo');
select tests.authenticate_as(:'buyer_dp');
select is((select count(*) from delivery_photos where order_id = :'o1_id')::int, 1, 'item 8: buyer-for-site sees the photo');
select tests.authenticate_as(:'driver_dp');
select is((select count(*) from delivery_photos where order_id = :'o1_id')::int, 1, 'item 9: driver sees the photo');

-- item 10: a stranger (company member, not on the site) sees nothing
select tests.authenticate_as(:'stranger_dp');
select is((select count(*) from delivery_photos where order_id = :'o1_id')::int, 0, 'item 10: a non-site-member sees no photos');

-- item 11: still works after the order is delivered
select tests.authenticate_as(:'driver_dp');
select mark_delivered(:'o1_id', now(), 'Site gate');
select (add_delivery_photo(:'o1_id', :'o1_id' || '/photo2.jpg')).id as p2 \gset
select ok(:'p2' is not null, 'item 11: a photo can still be added after delivery');

select finish();
rollback;
