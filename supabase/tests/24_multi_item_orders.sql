-- Multi-item orders (migration 0030).
begin;
select plan(20);

select tests.create_user('owner-mi@test.local', 'Owner MI')   as owner_mi \gset
select tests.create_user('worker-mi@test.local', 'Worker MI') as worker_mi \gset
select tests.create_user('owner-x@test.local', 'Owner X')     as owner_x \gset

insert into communities (name, invite_code, owner_id, require_owner_approval) values ('MI Co', 'MICO01', :'owner_mi', false) returning id as co \gset
insert into sites (community_id, name, created_by_id) values (:'co', 'MI Site', :'owner_mi') returning id as site \gset
insert into community_memberships (community_id, user_id, status, decided_by_id) values (:'co', :'worker_mi', 'approved', :'owner_mi');
insert into site_memberships (site_id, community_id, user_id, added_by_id) values (:'site', :'co', :'worker_mi', :'owner_mi');
insert into communities (name, invite_code, owner_id) values ('X Co', 'XCO001', :'owner_x') returning id as co_x \gset

-- Part A — signature / grant integrity
select ok(
  to_regprocedure('public.create_order(uuid, uuid, jsonb, text, double precision, double precision, text, text, text, text, text, text, timestamptz, text)') is not null
  and to_regprocedure('public.edit_order(uuid, integer, jsonb, text, double precision, double precision, uuid, text, text, text, text, text, text, timestamptz)') is not null,
  'item 1: the new p_items jsonb create_order/edit_order signatures resolve to real functions');
select ok(
  has_function_privilege('authenticated', 'create_order(uuid, uuid, jsonb, text, double precision, double precision, text, text, text, text, text, text, timestamptz, text)', 'EXECUTE')
  and not has_function_privilege('anon', 'create_order(uuid, uuid, jsonb, text, double precision, double precision, text, text, text, text, text, text, timestamptz, text)', 'EXECUTE'),
  'item 2: authenticated (not anon) can execute the new create_order');
select ok(exists(select 1 from information_schema.tables where table_name = 'order_items'), 'item 3: order_items table exists');

select tests.authenticate_as(:'worker_mi');

-- Part B — multi-item create_order
select create_order(
  :'co', :'site',
  '[{"productId":"p1","productName":"Cement","variant":"25kg bag","quantity":3,"unit":"bag","unitPrice":6.75},
    {"productId":"p2","productName":"Sand","variant":null,"quantity":2,"unit":"bag","unitPrice":4.50}]'::jsonb,
  'SW1A 1AA', null, null, 'b1', 'Merchant', 'm.co.uk', 'SW1 1AA', 'today', 'asap', null, 'driver'
) as multi \gset
select (:'multi'::orders).id as multi_id \gset

select is((:'multi'::orders).total_price, 29.25::numeric,
  'item 4: total_price is the server-computed sum of every line (3*6.75 + 2*4.50)');
select is((:'multi'::orders).product_name, 'Cement + 1 more',
  'item 5: the denormalised headline names the first item plus a "+ N more" count');
select is((:'multi'::orders).variant, null,
  'item 6: the headline variant is null for a multi-item order');
select is((select count(*)::int from order_items where order_id = :'multi_id'), 2,
  'item 7: both line items were inserted');
select is(
  (select string_agg(product_name, ',' order by sort_order) from order_items where order_id = :'multi_id'),
  'Cement,Sand', 'item 8: line items keep their submitted order via sort_order');
select is(
  (select line_total from order_items where order_id = :'multi_id' and product_name = 'Sand'),
  9.00::numeric, 'item 9: each line_total is server-computed (2 * 4.50)');

-- Part C — single item still works cleanly
select create_order(
  :'co', :'site',
  '[{"productId":"p3","productName":"Timber","variant":"2.4m","quantity":10,"unit":"length","unitPrice":8.00}]'::jsonb,
  'SW1A 1AA', null, null, 'b1', 'Merchant', 'm.co.uk', 'SW1 1AA', 'today', 'asap', null, 'driver'
) as single \gset
select is((:'single'::orders).product_name, 'Timber', 'item 10: a single-item order''s headline is just the product name');
select is((:'single'::orders).variant, '2.4m', 'item 11: a single-item order keeps its variant on the headline');
select is((:'single'::orders).total_price, 80.00::numeric, 'item 12: single-item total is correct');

-- Part D — validation
select throws_ok(
  format($$ select create_order(%L, %L, '[]'::jsonb, 'SW1A 1AA', null, null, 'b1','M','m.co.uk','SW1 1AA','today','asap',null,'driver') $$, :'co', :'site'),
  '22023', null, 'item 13: an empty item list is refused');
select throws_ok(
  format($$ select create_order(%L, %L, '[{"productName":"NoId","quantity":1,"unit":"each"}]'::jsonb, 'SW1A 1AA', null, null, 'b1','M','m.co.uk','SW1 1AA','today','asap',null,'driver') $$, :'co', :'site'),
  '22023', null, 'item 14: an item missing productId is refused');
select throws_ok(
  format($$ select create_order(%L, %L, '[{"productId":"p1","productName":"Bad","quantity":0,"unit":"each"}]'::jsonb, 'SW1A 1AA', null, null, 'b1','M','m.co.uk','SW1 1AA','today','asap',null,'driver') $$, :'co', :'site'),
  '22023', null, 'item 15: a zero quantity is refused');
select throws_ok(
  format($$ select create_order(%L, %L, '[{"productId":"p1","productName":"Bad","quantity":1,"unit":"each","unitPrice":-5}]'::jsonb, 'SW1A 1AA', null, null, 'b1','M','m.co.uk','SW1 1AA','today','asap',null,'driver') $$, :'co', :'site'),
  '22023', null, 'item 16: a negative unit price is refused');

-- Part E — edit_order item replacement
select (:'multi'::orders).version as multi_v \gset
select edit_order(
  :'multi_id', :'multi_v',
  '[{"productId":"p1","productName":"Cement","variant":"25kg bag","quantity":5,"unit":"bag","unitPrice":6.75}]'::jsonb,
  'SW1A 1AA', null, null, :'site', 'b1', 'Merchant', 'm.co.uk', 'SW1 1AA', 'today', 'asap', null
) as edited \gset
select is((select count(*)::int from order_items where order_id = :'multi_id'), 1,
  'item 17: editing to a shorter item list replaces order_items (2 -> 1)');
select is((:'edited'::orders).total_price, 33.75::numeric,
  'item 18: total_price is recomputed on edit (5 * 6.75)');
select ok(
  exists(select 1 from order_events where order_id = :'multi_id' and type = 'order_edited' and meta->'changes' ? 'items'),
  'item 19: the order_edited event records an ''items'' change');

-- Part F — order_items RLS isolation
select tests.authenticate_as(:'owner_x');
select is((select count(*)::int from order_items where order_id = :'multi_id'), 0,
  'item 20: an unrelated company''s owner cannot see this order''s line items');

select finish();
rollback;
