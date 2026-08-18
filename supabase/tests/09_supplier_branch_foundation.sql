-- Phase B — supplier/supplier_branches data foundation (migration 0017).
-- Covers: table existence, exact seeded fixture counts, uniqueness/FK/
-- check-constraint enforcement, authenticated read access to active rows,
-- anon denial, authenticated write denial (this is global reference data —
-- no role, including a community Owner, may write to it through the app),
-- and inactive-row exclusion from normal reads.
begin;
select plan(21);

-- ================================================================
-- items 1-9: structural checks, exact seed counts, and constraint
-- enforcement — run before any role switch, while still privileged, since
-- `authenticated` has no write grant on these tables at all (tested below).
-- ================================================================

select has_table('suppliers', 'item 1: suppliers table exists');
select has_table('supplier_branches', 'item 2: supplier_branches table exists');

select is(
  (select count(*) from suppliers)::int, 6,
  'item 3: exactly 6 supplier brands were seeded, matching data.js''s BRANCHES fixture'
);
select is(
  (select count(*) from supplier_branches)::int, 12,
  'item 4: exactly 12 branches were seeded, matching data.js''s BRANCHES fixture'
);

select throws_ok(
  $$ insert into suppliers (name, website) values ('Travis Perkins', 'fake.co.uk') $$,
  '23505', null,
  'item 5: duplicate supplier name is rejected (unique constraint)'
);

select throws_ok(
  format($$ insert into supplier_branches (supplier_id, catalogue_key, name, postcode) values (%L, 'b1', 'Test', 'ZZ1 1ZZ') $$,
    (select id from suppliers where name = 'Travis Perkins')),
  '23505', null,
  'item 6: duplicate catalogue_key is rejected (unique constraint)'
);

select throws_ok(
  $$ insert into supplier_branches (supplier_id, catalogue_key, name, postcode) values (gen_random_uuid(), 'test-fk-branch', 'Test', 'ZZ2 2ZZ') $$,
  '23503', null,
  'item 7: a supplier_branches row referencing a nonexistent supplier_id is rejected (FK)'
);

select throws_ok(
  format($$ insert into supplier_branches (supplier_id, catalogue_key, name, postcode, latitude) values (%L, 'test-lat-branch', 'Test', 'ZZ3 3ZZ', 999) $$,
    (select id from suppliers where name = 'Travis Perkins')),
  '23514', null,
  'item 8: an out-of-range latitude is rejected (check constraint)'
);

select throws_ok(
  format($$ insert into supplier_branches (supplier_id, catalogue_key, name, postcode, longitude) values (%L, 'test-lon-branch', 'Test', 'ZZ4 4ZZ', 999) $$,
    (select id from suppliers where name = 'Travis Perkins')),
  '23514', null,
  'item 9: an out-of-range longitude is rejected (check constraint)'
);

-- Deactivate one supplier and one (different) branch for the inactive-row
-- tests below — done here, still privileged, before any role switch, since
-- `authenticated` has no UPDATE grant on either table (tested below too).
update suppliers set active = false where name = 'Selco';
update supplier_branches set active = false where catalogue_key = 'b7';

-- ================================================================
-- items 10-11, 20-21: authenticated read access, active-only, via a real
-- authenticated role switch (not just SQL run as the privileged test role).
-- ================================================================

select tests.create_user('supplier-test-user@test.local', 'Supplier Test User') as test_user \gset
select tests.authenticate_as(:'test_user');

select is(
  (select count(*) from suppliers)::int, 5,
  'item 10: authenticated sees exactly 5 active suppliers (6 seeded, 1 deactivated, RLS excludes it)'
);
select is(
  (select count(*) from supplier_branches)::int, 9,
  'item 11: authenticated sees exactly 9 active branches (12 seeded, minus b7 directly deactivated, minus Selco''s b3/b8 hidden via its now-inactive parent supplier — see migration 0018)'
);

select is_empty(
  $$ select 1 from suppliers where name = 'Selco' $$,
  'item 20: the deactivated supplier (Selco) is invisible to a normal authenticated read'
);
select is_empty(
  $$ select 1 from supplier_branches where catalogue_key = 'b7' $$,
  'item 21: the deactivated branch (b7) is invisible to a normal authenticated read'
);

-- ================================================================
-- items 14-19: authenticated write denial — this is global reference data;
-- no ordinary authenticated user, including a community Owner, may modify
-- it through the app. No RPC exposes a write path either.
-- ================================================================

select throws_ok(
  $$ insert into suppliers (name, website) values ('Hostile Supplier', 'hostile.co.uk') $$,
  '42501', null,
  'item 14: authenticated cannot INSERT into suppliers (no grant)'
);
select throws_ok(
  $$ update suppliers set name = 'Renamed' where name = 'Jewson' $$,
  '42501', null,
  'item 15: authenticated cannot UPDATE suppliers (no grant)'
);
select throws_ok(
  $$ delete from suppliers where name = 'Jewson' $$,
  '42501', null,
  'item 16: authenticated cannot DELETE from suppliers (no grant)'
);
select throws_ok(
  format($$ insert into supplier_branches (supplier_id, catalogue_key, name, postcode) values (%L, 'hostile-branch', 'Hostile', 'ZZ5 5ZZ') $$,
    (select id from suppliers where name = 'Travis Perkins')),
  '42501', null,
  'item 17: authenticated cannot INSERT into supplier_branches (no grant)'
);
select throws_ok(
  $$ update supplier_branches set name = 'Renamed' where catalogue_key = 'b1' $$,
  '42501', null,
  'item 18: authenticated cannot UPDATE supplier_branches (no grant)'
);
select throws_ok(
  $$ delete from supplier_branches where catalogue_key = 'b1' $$,
  '42501', null,
  'item 19: authenticated cannot DELETE from supplier_branches (no grant)'
);

-- ================================================================
-- items 12-13: anon denial — a real anonymous connection, refused at the
-- grant-check layer before RLS is even evaluated (no table grant to anon
-- exists at all for either table).
-- ================================================================

select tests.clear_authentication();

select throws_ok(
  $$ select count(*) from suppliers $$,
  '42501', null,
  'item 12: anon cannot read suppliers (no grant)'
);
select throws_ok(
  $$ select count(*) from supplier_branches $$,
  '42501', null,
  'item 13: anon cannot read supplier_branches (no grant)'
);

select finish();
rollback;
