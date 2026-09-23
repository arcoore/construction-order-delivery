-- Migration 0054: supplier offers, server-verified offer prices, stale-link
-- clearing, the offer importer, and affiliate click logging.
begin;
select plan(51);

select tests.create_user('so-owner@test.local',  'SO Owner')  as owner  \gset
select tests.create_user('so-worker@test.local', 'SO Worker') as worker \gset
select tests.create_user('so-buyer@test.local',  'SO Buyer')  as buyer  \gset
select tests.create_user('so-stranger@test.local', 'SO Stranger') as stranger \gset

select tests.authenticate_as(:'owner');
insert into communities (name, invite_code, owner_id) values ('SO Co', 'SOCO01', :'owner') returning id as co \gset
insert into sites (community_id, name, address, postcode, created_by_id) values (:'co', 'SO Site', '1 Test St', 'AA1 1AA', :'owner') returning id as site \gset

select tests.authenticate_as(:'worker');
insert into community_memberships (community_id, user_id, status) values (:'co', :'worker', 'pending');
select tests.authenticate_as(:'buyer');
insert into community_memberships (community_id, user_id, status) values (:'co', :'buyer', 'pending');

select tests.authenticate_as(:'owner');
select tests.set_membership_status(:'co', :'worker', 'approved', :'owner');
select tests.set_membership_status(:'co', :'buyer',  'approved', :'owner');
insert into site_memberships (site_id, community_id, user_id, added_by_id) values
  (:'site', :'co', :'worker', :'owner'),
  (:'site', :'co', :'buyer',  :'owner');
insert into buyer_grants (community_id, user_id, granted_by_id) values (:'co', :'buyer', :'owner');

-- ============================================================ schema config
select tests.clear_authentication();
reset role;

select throws_ok(
  $$ update suppliers set affiliate_network = 'awin' where name = 'Wickes Trade' $$,
  '23514', null,
  'item 1: an affiliate network with no merchant id is refused');
select throws_ok(
  $$ update suppliers set search_url_template = 'https://example.com/search' where name = 'Wickes Trade' $$,
  '23514', null,
  'item 2: a search URL template without {query} is refused');
select throws_ok(
  $$ update suppliers set search_url_template = 'http://example.com/s?q={query}' where name = 'Wickes Trade' $$,
  '23514', null,
  'item 3: a non-https search URL template is refused');
select lives_ok(
  $$ update suppliers set affiliate_network = 'awin', affiliate_merchant_id = '12345',
       search_url_template = 'https://example.com/s?q={query}' where name = 'Wickes Trade' $$,
  'item 4: a complete affiliate + search config is accepted');

-- ============================================================ grants
select tests.authenticate_as(:'stranger');
select throws_ok(
  $$ select import_supplier_offers('Wickes Trade', '[]'::jsonb) $$,
  '42501', null,
  'item 5: an authenticated user cannot run the offer importer');
select tests.clear_authentication();
select throws_ok(
  $$ select import_supplier_offers('Wickes Trade', '[]'::jsonb) $$,
  '42501', null,
  'item 6: anon cannot run the offer importer');
reset role;

-- ============================================================ importer
set local role service_role;
select is(
  (import_supplier_offers('Wickes Trade', $j$[
    {"externalId":"W-1","productKey":"p3","variantLabel":"25kg bag","title":"Cement 25kg","unitPrice":5.20,"inStock":true,"productUrl":"https://example.com/p/w-1"},
    {"externalId":"W-2","productKey":"p3","variantLabel":"25kg bag","title":"Cement 25kg (dup, dearer)","unitPrice":6.00,"inStock":true},
    {"externalId":"W-3","productKey":"p1","title":"Timber post any size","unitPrice":9.99}
  ]$j$::jsonb))->>'upserted',
  '2', 'item 7: a duplicate mapping in one batch collapses to one row (cheapest kept)');
reset role;

select is((select unit_price from supplier_offers where external_id = 'W-1'), 5.20::numeric,
  'item 8: the cheaper duplicate is the one kept');
select is((select count(*)::int from supplier_offers where external_id = 'W-2'), 0,
  'item 9: the dearer duplicate is not stored');
select is((select source from supplier_offers where external_id = 'W-1'), 'feed',
  'item 10: imported offers are marked source=feed');

set local role service_role;
select is(
  (import_supplier_offers('Wickes Trade', $j$[
    {"externalId":"W-1","productKey":"p3","variantLabel":"25kg bag","title":"Cement 25kg","unitPrice":5.45,"inStock":false}
  ]$j$::jsonb))->>'deactivated',
  '1', 'item 11: a re-import that omits a product deactivates it');
reset role;
select is((select active from supplier_offers where external_id = 'W-3'), false,
  'item 12: the omitted offer is now inactive, not deleted');
select is((select unit_price from supplier_offers where external_id = 'W-1'), 5.45::numeric,
  'item 13: a re-import updates the price in place');
select is((select in_stock from supplier_offers where external_id = 'W-1'), false,
  'item 14: a re-import updates the stock flag');

set local role service_role;
select lives_ok(
  $$ select import_supplier_offers('Wickes Trade', $j$[
       {"externalId":"W-1","productKey":"p2","title":"Now maps to rebar","unitPrice":5.45}
     ]$j$::jsonb) $$,
  'item 15: a SKU remapped to a different product in the same sync imports cleanly');
select throws_ok(
  $$ select import_supplier_offers('No Such Merchant', '[]'::jsonb) $$,
  '42704', null, 'item 16: an unknown supplier is refused');
select throws_ok(
  $$ select import_supplier_offers('Wickes Trade', '[{"externalId":"X","productKey":"p999","title":"t","unitPrice":1}]'::jsonb) $$,
  '23503', null, 'item 17: an unknown product key is refused');
select throws_ok(
  $$ select import_supplier_offers('Wickes Trade', '[{"externalId":"X","productKey":"p1","title":"t","unitPrice":-1}]'::jsonb) $$,
  '23514', null, 'item 18: a negative price is refused');
select throws_ok(
  $$ select import_supplier_offers('Wickes Trade', '[{"externalId":"X","productKey":"p1","title":"t","unitPrice":1,"productUrl":"javascript:alert(1)"}]'::jsonb) $$,
  '23514', null, 'item 19: a non-https product URL (javascript:) is refused');
reset role;

-- a manual offer is never touched by a feed sync
insert into supplier_offers (supplier_id, product_key, external_id, title, unit_price, source)
  values ((select id from suppliers where name = 'Wickes Trade'), 'p5', 'MAN-1', 'Hand entered', 3.00, 'manual');
set local role service_role;
select import_supplier_offers('Wickes Trade', '[]'::jsonb);
reset role;
select is((select active from supplier_offers where external_id = 'MAN-1'), true,
  'item 20: a manual offer survives a feed sync that omits it');

-- ============================================================ read access
-- fresh, known offers for the order tests below
set local role service_role;
select import_supplier_offers('Wickes Trade', $j$[
  {"externalId":"W-CEM","productKey":"p3","variantLabel":"25kg bag","title":"Cement 25kg","unitPrice":5.20,"inStock":true,"productUrl":"https://example.com/p/w-cem"}
]$j$::jsonb);
select import_supplier_offers('Travis Perkins', $j$[
  {"externalId":"T-CEM","productKey":"p3","variantLabel":"25kg bag","title":"Cement 25kg TP","unitPrice":5.90,"inStock":true,"productUrl":"https://example.com/p/t-cem"}
]$j$::jsonb);
reset role;

select tests.clear_authentication();
select throws_ok($$ select count(*) from supplier_offers $$, '42501', null,
  'item 21: anon cannot read supplier_offers');

select tests.authenticate_as(:'stranger');
select cmp_ok((select count(*)::int from supplier_offers where external_id = 'W-CEM'), '=', 1,
  'item 22: any signed-in user can read a live offer');
select is((select count(*)::int from supplier_offers where external_id = 'W-1' and active = false), 0,
  'item 23: inactive offers are invisible to signed-in users');
select throws_ok($$ insert into supplier_offers (supplier_id, product_key, external_id, title, unit_price)
  values ((select id from suppliers limit 1), 'p1', 'HACK', 'x', 0.01) $$, '42501', null,
  'item 24: a signed-in user cannot insert an offer');
select throws_ok($$ update supplier_offers set unit_price = 0.01 $$, '42501', null,
  'item 25: a signed-in user cannot change an offer price');

-- ============================================================ order pricing
select id as w_offer from supplier_offers where external_id = 'W-CEM' \gset
select id as t_offer from supplier_offers where external_id = 'T-CEM' \gset

select tests.authenticate_as(:'worker');
select (create_order(
  :'co', :'site',
  jsonb_build_array(jsonb_build_object('productId','p3','productName','Cement','variant','25kg bag','quantity',10,'unit','bag','unitPrice',5.20,'offerId',:'w_offer')),
  'AA1 1AA', null, null, 'b4', 'Wickes Trade - Leeds', 'wickes.co.uk', 'LS10 1AB', null, null, null, 'driver'
)).id as ord \gset

select is((select price_source from order_items where order_id = :'ord'), 'feed',
  'item 26: an offer-backed line records price_source=feed');
select is((select offer_url from order_items where order_id = :'ord'), 'https://example.com/p/w-cem',
  'item 27: the offer''s product URL is snapshotted onto the line');
select is((select offer_id from order_items where order_id = :'ord'), :'w_offer'::uuid,
  'item 28: the line remembers which offer priced it');
select is((select total_price from orders where id = :'ord'), 52.00::numeric,
  'item 29: the order total matches the verified line total');

select throws_ok(
  format($$ select create_order(%L, %L,
    jsonb_build_array(jsonb_build_object('productId','p3','productName','Cement','variant','25kg bag','quantity',10,'unit','bag','unitPrice',1.00,'offerId',%L)),
    'AA1 1AA', null, null, 'b4', 'Wickes Trade - Leeds', 'wickes.co.uk', 'LS10 1AB', null, null, null, 'driver') $$,
    :'co', :'site', :'w_offer'),
  '22023', 'a supplier price changed - please review the order and try again',
  'item 30: an offer-backed line with a forged (lower) price is refused');
select throws_ok(
  format($$ select create_order(%L, %L,
    jsonb_build_array(jsonb_build_object('productId','p3','productName','Cement','variant','25kg bag','quantity',10,'unit','bag','unitPrice',5.90,'offerId',%L)),
    'AA1 1AA', null, null, 'b4', 'Wickes Trade - Leeds', 'wickes.co.uk', 'LS10 1AB', null, null, null, 'driver') $$,
    :'co', :'site', :'t_offer'),
  '22023', 'that supplier price belongs to a different supplier than this order''s stockist',
  'item 31: another supplier''s (correctly priced) offer cannot be used on this order');
select throws_ok(
  format($$ select create_order(%L, %L,
    jsonb_build_array(jsonb_build_object('productId','p3','productName','Cement','variant','25kg bag','quantity',1,'unit','bag','unitPrice',5.20,'offerId','not-a-uuid')),
    'AA1 1AA', null, null, 'b4', 'Wickes Trade - Leeds', 'wickes.co.uk', 'LS10 1AB', null, null, null, 'driver') $$,
    :'co', :'site'),
  '22023', null, 'item 32: a malformed offer id is refused cleanly (not a cast crash)');
select throws_ok(
  format($$ select create_order(%L, %L,
    jsonb_build_array(jsonb_build_object('productId','p3','productName','Cement','variant','25kg bag','quantity',1,'unit','bag','unitPrice',5.20,'offerId',gen_random_uuid())),
    'AA1 1AA', null, null, 'b4', 'Wickes Trade - Leeds', 'wickes.co.uk', 'LS10 1AB', null, null, null, 'driver') $$,
    :'co', :'site'),
  '22023', null, 'item 33: an offer id that does not exist is refused');

-- an item with no offerId behaves exactly as before
select (create_order(
  :'co', :'site',
  jsonb_build_array(jsonb_build_object('productId','p3','productName','Cement','variant','custom size','quantity',2,'unit','bag','unitPrice',7.77)),
  'AA1 1AA', null, null, 'b4', 'Wickes Trade - Leeds', 'wickes.co.uk', 'LS10 1AB', null, null, null, 'driver'
)).id as ord_plain \gset
select is((select price_source from order_items where order_id = :'ord_plain'), 'client',
  'item 34: a line with no offer keeps the client-asserted price_source');
select is((select offer_id is null from order_items where order_id = :'ord_plain'), true,
  'item 35: a line with no offer has no offer_id');

-- an offer that went inactive between browse and submit is refused
select tests.clear_authentication();
reset role;
update supplier_offers set active = false where id = :'w_offer';
select tests.authenticate_as(:'worker');
select throws_ok(
  format($$ select create_order(%L, %L,
    jsonb_build_array(jsonb_build_object('productId','p3','productName','Cement','variant','25kg bag','quantity',1,'unit','bag','unitPrice',5.20,'offerId',%L)),
    'AA1 1AA', null, null, 'b4', 'Wickes Trade - Leeds', 'wickes.co.uk', 'LS10 1AB', null, null, null, 'driver') $$,
    :'co', :'site', :'w_offer'),
  '22023', null, 'item 36: an inactive offer is refused');
select tests.clear_authentication();
reset role;
update supplier_offers set active = true where id = :'w_offer';

-- ============================================================ stockist change
select tests.authenticate_as(:'worker');
select version as v from orders where id = :'ord' \gset
select lives_ok(
  format($$ select edit_order(%L, %s,
    jsonb_build_array(jsonb_build_object('productId','p3','productName','Cement','variant','25kg bag','quantity',10,'unit','bag','unitPrice',5.20,'offerId',%L)),
    'AA1 1AA', null, null, %L, 'b1', 'Travis Perkins - London Wandsworth', 'travisperkins.co.uk', 'SW18 4ES', null, null, null) $$,
    :'ord', :'v', :'w_offer', :'site'),
  'item 37: an order can be moved to a different supplier');
select is((select offer_id is null from order_items where order_id = :'ord'), true,
  'item 38: moving supplier clears the old supplier''s offer link');
select is((select price_source from order_items where order_id = :'ord'), 'client',
  'item 39: and reverts the line to a client-asserted price');
select is((select offer_url is null from order_items where order_id = :'ord'), true,
  'item 40: and drops the old supplier''s product URL');

-- ============================================================ click logging
select tests.authenticate_as(:'buyer');
select lives_ok(
  format($$ select log_affiliate_click(%L, 'deep', true) $$, :'ord'),
  'item 41: a buyer for the site can log a supplier-link click');
select tests.authenticate_as(:'worker');
select throws_ok(
  format($$ select log_affiliate_click(%L, 'deep', true) $$, :'ord'),
  '42501', null, 'item 42: a plain worker cannot log a click');
select tests.authenticate_as(:'stranger');
select throws_ok(
  format($$ select log_affiliate_click(%L, 'deep', true) $$, :'ord'),
  '42501', null, 'item 43: a stranger cannot log a click');
select tests.clear_authentication();
select throws_ok(
  format($$ select log_affiliate_click(%L, 'deep', true) $$, :'ord'),
  '42501', null, 'item 44: anon cannot log a click');

select tests.authenticate_as(:'buyer');
select throws_ok(
  format($$ select log_affiliate_click(%L, 'carrier-pigeon', false) $$, :'ord'),
  '23514', null, 'item 45: an unknown link kind is refused');
select throws_ok($$ select count(*) from affiliate_clicks $$, '42501', null,
  'item 46: the click log is not readable by a signed-in user');

-- 30 per minute per order, then refused
select lives_ok(
  format($$ select log_affiliate_click(%L, 'search', false) from generate_series(1, 28) $$, :'ord'),
  'item 47: up to the per-order limit is accepted');
select throws_ok(
  format($$ select log_affiliate_click(%L, 'home', false) from generate_series(1, 5) $$, :'ord'),
  '53400', null, 'item 48: clicks beyond the per-order minute limit are throttled');

-- ============================================================ retention
select tests.clear_authentication();
select throws_ok($$ select prune_affiliate_clicks() $$, '42501', null,
  'item 49: prune_affiliate_clicks is not callable by a client role');
reset role;
select set_config('request.jwt.claims', '', true);
-- age two of the logged clicks past the 400-day window
update affiliate_clicks set created_at = now() - interval '401 days'
  where id in (select id from affiliate_clicks order by id limit 2);
select is(prune_affiliate_clicks(), 2, 'item 50: clicks older than 400 days are pruned');
select cmp_ok((select count(*) from affiliate_clicks), '>', 0::bigint,
  'item 51: recent clicks are kept');

select finish();
rollback;
