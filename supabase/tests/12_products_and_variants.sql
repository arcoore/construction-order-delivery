-- Roadmap Step 3 — product catalogue (migration 0020). Covers: the seeded
-- catalogue is exactly the pre-migration data.js fixture (16 products, 50
-- variants, stable p1..p16 keys); active-only visibility for both tables,
-- including the parent-active rule for variants (learned correctly from
-- Phase B's 0017→0018 sequence, not left as a follow-up gap); no write
-- access for authenticated or anon; standard constraint enforcement
-- (unique catalogue_key, unique (product_id, label), non-negative price,
-- valid parent FK); variant display order preserved; and that
-- create_order/edit_order's 0019 signatures are genuinely untouched by this
-- migration — this phase is a catalogue-location move, not a change to
-- order-lifecycle RPCs.
--
-- All privileged setup AND constraint-violation attempts happen up front,
-- before the single role switch to `authenticated` below — this project's
-- pgTAP helpers (see 00_helpers.sql) only ever move privilege DOWNWARD
-- within one file (there is no way back to the ambient/privileged role
-- after tests.authenticate_as/clear_authentication is first called), so a
-- constraint-violation INSERT attempted after that point would fail on the
-- RLS/grant check before ever reaching the constraint itself — exactly the
-- ordering discipline 10_supplier_activity_hardening.sql's own header
-- already documents.
begin;
select plan(29);

-- ================================================================
-- items 1-4: seeded catalogue shape and stable keys
-- ================================================================

select is(
  (select count(*)::int from products),
  16,
  'item 1: exactly 16 products seeded'
);
select is(
  (select count(*)::int from product_variants),
  50,
  'item 2: exactly 50 variants seeded (matching the pre-migration data.js catalogue)'
);
select is(
  (select count(distinct catalogue_key)::int from products where catalogue_key ~ '^p([1-9]|1[0-6])$'),
  16,
  'item 3: all 16 catalogue keys are exactly p1..p16'
);
select is(
  (select count(*)::int from product_variants pv join products p on p.id = pv.product_id where p.catalogue_key = 'p3'),
  2,
  'item 4: General Purpose Cement (p3) has exactly its 2 original variants'
);

-- ================================================================
-- Fixtures for active/inactive visibility — dedicated test rows, never the
-- real seed, so each combination is unambiguous. Still privileged.
-- ================================================================

insert into products (catalogue_key, name, category, unit, unit_price, active) values
  ('test-active-product',   'Test Active Product',   'Test', 'each', 1.00, true),
  ('test-inactive-product', 'Test Inactive Product',  'Test', 'each', 1.00, false);

select id from products where catalogue_key = 'test-active-product' \gset active_product_
select id from products where catalogue_key = 'test-inactive-product' \gset inactive_product_

insert into product_variants (product_id, label, sort_order, active) values
  (:'active_product_id',   'Active variant, active parent',     0, true),
  (:'active_product_id',   'Inactive variant, active parent',   1, false),
  (:'inactive_product_id', 'Active variant, inactive parent',   0, true),
  (:'inactive_product_id', 'Inactive variant, inactive parent', 1, false);

-- Reactivation fixture — starts inactive, flipped back before the role
-- switch, checked as an end state once authenticated (same reasoning
-- 10_supplier_activity_hardening.sql's header already documents).
insert into products (catalogue_key, name, category, unit, unit_price, active) values
  ('test-reactivate-product', 'Test Reactivate Product', 'Test', 'each', 1.00, false);
update products set active = true where catalogue_key = 'test-reactivate-product';

-- ================================================================
-- items 5-8: constraint enforcement — must run while still privileged,
-- since `authenticated` has no write grant at all on either table (proven
-- separately below) and a permission refusal would otherwise mask whether
-- the constraint itself works.
-- ================================================================

select throws_ok(
  $$ insert into products (catalogue_key, name, category, unit, unit_price) values ('p1', 'Duplicate Key', 'Test', 'each', 1.00) $$,
  '23505', null,
  'item 5: duplicate product catalogue_key rejected'
);
select throws_ok(
  format($$ insert into product_variants (product_id, label) values (%L, 'Active variant, active parent') $$, :'active_product_id'),
  '23505', null,
  'item 6: duplicate (product_id, label) rejected'
);
select throws_ok(
  $$ insert into product_variants (product_id, label) values ('00000000-0000-0000-0000-000000000000', 'Orphan Variant') $$,
  '23503', null,
  'item 7: variant with a non-existent parent product_id rejected'
);
select throws_ok(
  $$ insert into products (catalogue_key, name, category, unit, unit_price) values ('test-negative-price', 'Negative Price', 'Test', 'each', -1.00) $$,
  '23514', null,
  'item 8: negative unit_price rejected'
);

-- ================================================================
-- items 9-15: active/inactive visibility, as a real authenticated role
-- (RLS is only meaningfully exercised by a non-superuser role).
-- ================================================================

select tests.create_user('products-test@test.local', 'Products Test User') as test_user \gset
select tests.authenticate_as(:'test_user');

select isnt_empty(
  $$ select 1 from products where catalogue_key = 'test-active-product' $$,
  'item 9: active product IS visible to authenticated'
);
select is_empty(
  $$ select 1 from products where catalogue_key = 'test-inactive-product' $$,
  'item 10: inactive product NOT visible to authenticated'
);
select isnt_empty(
  $$ select 1 from product_variants where label = 'Active variant, active parent' $$,
  'item 11: active variant of active product IS visible'
);
select is_empty(
  $$ select 1 from product_variants where label = 'Inactive variant, active parent' $$,
  'item 12: inactive variant NOT visible even though its parent is active'
);
select is_empty(
  $$ select 1 from product_variants where label = 'Active variant, inactive parent' $$,
  'item 13: active variant hidden when its PARENT product is inactive (the Phase B 0018 lesson, applied from the start here)'
);
select is_empty(
  $$ select 1 from product_variants where label = 'Inactive variant, inactive parent' $$,
  'item 14: inactive variant + inactive parent NOT visible (both reasons)'
);
select isnt_empty(
  $$ select 1 from products where catalogue_key = 'test-reactivate-product' $$,
  'item 15: a product that was deactivated then reactivated is visible again'
);

-- ================================================================
-- items 16-17: real seeded rows also readable as authenticated
-- ================================================================

select isnt_empty(
  $$ select 1 from products where catalogue_key = 'p1' $$,
  'item 16: real seeded product p1 readable by authenticated'
);
select is(
  (select count(*)::int from product_variants pv join products p on p.id = pv.product_id where p.catalogue_key = 'p11'),
  4,
  'item 17: Hi-Vis Safety Vest (p11) has all 4 original size variants visible'
);

-- ================================================================
-- items 18-19: variant display order preserved (sort_order)
-- ================================================================

select results_eq(
  $$ select pv.label from product_variants pv join products p on p.id = pv.product_id
     where p.catalogue_key = 'p3' order by pv.sort_order $$,
  $$ values ('10kg bag'), ('25kg bag') $$,
  'item 18: p3 variants return in original array order (10kg before 25kg)'
);
select results_eq(
  $$ select pv.label from product_variants pv join products p on p.id = pv.product_id
     where p.catalogue_key = 'p11' order by pv.sort_order $$,
  $$ values ('S'), ('M'), ('L'), ('XL') $$,
  'item 19: p11 variants return in original array order (S, M, L, XL)'
);

-- ================================================================
-- items 20-25: no write access for authenticated
-- ================================================================

select throws_ok(
  $$ insert into products (catalogue_key, name, category, unit, unit_price) values ('hostile', 'Hostile', 'Test', 'each', 1.00) $$,
  '42501', null,
  'item 20: authenticated cannot INSERT products'
);
select throws_ok(
  $$ update products set name = 'Renamed' where catalogue_key = 'p1' $$,
  '42501', null,
  'item 21: authenticated cannot UPDATE products'
);
select throws_ok(
  $$ delete from products where catalogue_key = 'p1' $$,
  '42501', null,
  'item 22: authenticated cannot DELETE products'
);
select throws_ok(
  format($$ insert into product_variants (product_id, label) values (%L, 'Hostile Variant') $$, :'active_product_id'),
  '42501', null,
  'item 23: authenticated cannot INSERT product_variants'
);
select throws_ok(
  $$ update product_variants set label = 'Renamed' where label = 'Active variant, active parent' $$,
  '42501', null,
  'item 24: authenticated cannot UPDATE product_variants'
);
select throws_ok(
  $$ delete from product_variants where label = 'Active variant, active parent' $$,
  '42501', null,
  'item 25: authenticated cannot DELETE product_variants'
);

-- ================================================================
-- items 26-27: no anon access at all
-- ================================================================

select tests.clear_authentication();
select throws_ok(
  $$ select count(*) from products $$,
  '42501', null,
  'item 26: anon cannot read products'
);
select throws_ok(
  $$ select count(*) from product_variants $$,
  '42501', null,
  'item 27: anon cannot read product_variants'
);

-- ================================================================
-- items 28-29: create_order/edit_order signatures genuinely untouched by
-- this migration (0019's 18/19-arg signatures, unchanged) — this phase is
-- a catalogue-location move, not an order-lifecycle RPC change.
-- ================================================================

select ok(
  to_regprocedure('create_order(uuid, uuid, text, text, text, numeric, text, text, double precision, double precision, text, text, text, text, text, numeric, text, timestamptz)') is not null,
  'item 28: create_order signature is exactly the one migration 0019 left it as (18 args)'
);
select ok(
  to_regprocedure('edit_order(uuid, integer, text, text, text, numeric, text, text, double precision, double precision, uuid, text, text, text, text, text, numeric, text, timestamptz)') is not null,
  'item 29: edit_order signature is exactly the one migration 0019 left it as (19 args)'
);

select finish();
rollback;
