-- Site contact snapshot on orders (migration 0031) — finishes 0027 by
-- getting the site's contact name/phone and access notes onto the order so
-- the driver collecting/delivering actually sees them. Covers: the three
-- new snapshot columns, create_order populating them from the site,
-- edit_order re-snapshotting them (including clearing them) on a site move,
-- and snapshot immutability when the live site record changes afterward.
begin;
select plan(11);

select tests.create_user('owner-sc@test.local', 'Owner SC')   as owner_sc \gset
select tests.create_user('worker-sc@test.local', 'Worker SC') as worker_sc \gset

insert into communities (name, invite_code, owner_id, require_owner_approval)
  values ('SC Co', 'SCCO01', :'owner_sc', false) returning id as co \gset

insert into sites (community_id, name, created_by_id, site_contact_name, site_contact_phone, access_notes)
  values (:'co', 'Site With Contact', :'owner_sc', 'Dave Foreman', '07700 900123', 'Gate code 4417') returning id as site_a \gset
insert into sites (community_id, name, created_by_id)
  values (:'co', 'Site No Contact', :'owner_sc') returning id as site_b \gset

insert into community_memberships (community_id, user_id, status, decided_by_id)
  values (:'co', :'worker_sc', 'approved', :'owner_sc');
insert into site_memberships (site_id, community_id, user_id, added_by_id) values
  (:'site_a', :'co', :'worker_sc', :'owner_sc'),
  (:'site_b', :'co', :'worker_sc', :'owner_sc');

-- ================================================================
-- Part A — columns exist.
-- ================================================================
select has_column('orders', 'site_contact_name',  'item 1: orders.site_contact_name exists');
select has_column('orders', 'site_contact_phone', 'item 2: orders.site_contact_phone exists');
select has_column('orders', 'site_access_notes',  'item 3: orders.site_access_notes exists');

-- ================================================================
-- Part B — create_order snapshots the contact from the site.
-- ================================================================
select tests.authenticate_as(:'worker_sc');

select tests.create_order_1(:'co', :'site_a', 'p2', 'Cement', null, 5, 'bag', 'SW1A 1AA', null, null, 'b1', 'Merchant', 'merchant.co.uk', 'SW1 1AA', 'today', 6.75, null, null) as r \gset
select (:'r'::orders).id as order_id \gset

select is((:'r'::orders).site_contact_name,  'Dave Foreman',   'item 4: create_order snapshots site_contact_name');
select is((:'r'::orders).site_contact_phone, '07700 900123',   'item 5: create_order snapshots site_contact_phone');
select is((:'r'::orders).site_access_notes,  'Gate code 4417', 'item 6: create_order snapshots access_notes onto site_access_notes');

-- ================================================================
-- Part C — editing the live site record never rewrites the order.
-- ================================================================
select tests.authenticate_as(:'owner_sc');
update sites set site_contact_name = 'Someone Else', access_notes = 'New code' where id = :'site_a';

select tests.authenticate_as(:'worker_sc');
select is(
  (select site_contact_name from orders where id = :'order_id'),
  'Dave Foreman',
  'item 7: renaming the site contact afterward does not change the already-placed order (point-in-time snapshot)'
);

-- ================================================================
-- Part D — moving the order to another site re-snapshots, and moving to a
-- site with no contact clears the fields (not coalesce'd from the old one).
-- ================================================================
select version as v from orders where id = :'order_id' \gset
select edit_order(
  :'order_id', :'v'::integer,
  jsonb_build_array(jsonb_build_object('productId','p2','productName','Cement','variant',null,'quantity',5,'unit','bag','unitPrice',6.75)),
  'SW1A 1AA', null, null, :'site_b', 'b1', 'Merchant', 'merchant.co.uk', 'SW1 1AA', 'today', null, null
);

select is((select site_contact_name  from orders where id = :'order_id'), null, 'item 8: moving to a site with no contact clears site_contact_name');
select is((select site_contact_phone from orders where id = :'order_id'), null, 'item 9: moving to a site with no contact clears site_contact_phone');
select is((select site_access_notes  from orders where id = :'order_id'), null, 'item 10: moving to a site with no contact clears site_access_notes');

select ok(
  exists(
    select 1 from order_events
    where order_id = :'order_id' and type = 'order_edited'
      and meta->'changes' ? 'siteContactName'
  ),
  'item 11: the site move records the contact change in meta.changes'
);

select finish();
rollback;
