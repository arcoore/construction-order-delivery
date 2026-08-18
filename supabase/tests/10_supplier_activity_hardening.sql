-- Phase B hardening (migration 0018) — supplier_branches visibility now
-- requires BOTH the branch's own active flag AND its parent supplier's.
-- Covers the exact gap found during the Phase B final audit: deactivating
-- a supplier previously had zero effect on whether its branches were still
-- offered for new orders. Uses dedicated fixture suppliers/branches (never
-- the real Phase B seed rows) so each of the four active/inactive
-- combinations is unambiguous and independent of what else exists.
--
-- All privileged setup (including the "reactivate a parent" mutation for
-- item 5) happens up front, before the single role switch to `authenticated`
-- below — this project's pgTAP helpers (see 00_helpers.sql) only ever move
-- privilege DOWNWARD within one file (there is no way back to the ambient
-- role after tests.authenticate_as/clear_authentication is first called),
-- and RLS is only meaningfully exercised by the non-superuser authenticated/
-- anon roles anyway (the ambient role bypasses RLS entirely). Item 5 is
-- therefore verified as an END STATE (a supplier that was deactivated and
-- then reactivated, checked once as authenticated), not a live before/after
-- transition within the test run — that still genuinely proves reactivation
-- restores visibility, without needing an impossible role reversal.
begin;
select plan(13);

-- ================================================================
-- Fixtures — three dedicated test suppliers, four dedicated test branches.
-- Still privileged (no role switch yet).
-- ================================================================

insert into suppliers (name, website, active) values
  ('Test Supplier Active', 'test-active.example', true),
  ('Test Supplier Inactive', 'test-inactive.example', false),
  ('Test Supplier WillReactivate', 'test-reactivate.example', false);

select id from suppliers where name = 'Test Supplier Active' \gset active_supplier_
select id from suppliers where name = 'Test Supplier Inactive' \gset inactive_supplier_
select id from suppliers where name = 'Test Supplier WillReactivate' \gset reactivate_supplier_

insert into supplier_branches (supplier_id, catalogue_key, name, postcode, active) values
  (:'active_supplier_id',     'test-active-parent-active-child',     'Active Parent / Active Child',     'ZZ10 1ZZ', true),
  (:'active_supplier_id',     'test-active-parent-inactive-child',   'Active Parent / Inactive Child',   'ZZ10 2ZZ', false),
  (:'inactive_supplier_id',   'test-inactive-parent-active-child',   'Inactive Parent / Active Child',   'ZZ10 3ZZ', true),
  (:'inactive_supplier_id',   'test-inactive-parent-inactive-child', 'Inactive Parent / Inactive Child', 'ZZ10 4ZZ', false),
  (:'reactivate_supplier_id', 'test-reactivate-child',               'Reactivated Parent / Active Child', 'ZZ10 5ZZ', true);

-- item 5's setup: this supplier started inactive (its branch was therefore
-- hidden — the same mechanism proven by item 2 below) and is now reactivated
-- — still privileged, before the role switch.
update suppliers set active = true where id = :'reactivate_supplier_id';

-- ================================================================
-- items 1-5: the four active/inactive combinations, plus reactivation,
-- checked as a real authenticated role (RLS is only meaningfully exercised
-- by a non-superuser role).
-- ================================================================

select tests.create_user('supplier-activity-test@test.local', 'Supplier Activity Test User') as test_user \gset
select tests.authenticate_as(:'test_user');

select isnt_empty(
  $$ select 1 from supplier_branches where catalogue_key = 'test-active-parent-active-child' $$,
  'item 1: active supplier + active branch → branch IS visible'
);
select is_empty(
  $$ select 1 from supplier_branches where catalogue_key = 'test-inactive-parent-active-child' $$,
  'item 2: inactive supplier + active branch → branch NOT visible (the audit-found gap, now closed)'
);
select is_empty(
  $$ select 1 from supplier_branches where catalogue_key = 'test-active-parent-inactive-child' $$,
  'item 3: active supplier + inactive branch → branch NOT visible'
);
select is_empty(
  $$ select 1 from supplier_branches where catalogue_key = 'test-inactive-parent-inactive-child' $$,
  'item 4: inactive supplier + inactive branch → branch NOT visible'
);
select isnt_empty(
  $$ select 1 from supplier_branches where catalogue_key = 'test-reactivate-child' $$,
  'item 5: a branch whose parent supplier was reactivated is visible again'
);

-- ================================================================
-- items 6-13: re-confirm 0018 changed nothing about write/anon denial —
-- it only replaced the supplier_branches SELECT policy.
-- ================================================================

select throws_ok(
  $$ update suppliers set name = 'Renamed' where name = 'Test Supplier Active' $$,
  '42501', null,
  'item 6: authenticated still cannot UPDATE suppliers'
);
select throws_ok(
  $$ delete from suppliers where name = 'Test Supplier Active' $$,
  '42501', null,
  'item 7: authenticated still cannot DELETE suppliers'
);
select throws_ok(
  $$ insert into suppliers (name, website) values ('Hostile Supplier 2', 'hostile2.example') $$,
  '42501', null,
  'item 8: authenticated still cannot INSERT suppliers'
);
select throws_ok(
  $$ update supplier_branches set name = 'Renamed' where catalogue_key = 'test-active-parent-active-child' $$,
  '42501', null,
  'item 9: authenticated still cannot UPDATE supplier_branches'
);
select throws_ok(
  $$ delete from supplier_branches where catalogue_key = 'test-active-parent-active-child' $$,
  '42501', null,
  'item 10: authenticated still cannot DELETE supplier_branches'
);
select throws_ok(
  format($$ insert into supplier_branches (supplier_id, catalogue_key, name, postcode) values (%L, 'hostile-branch-2', 'Hostile', 'ZZ99 9ZZ') $$,
    :'active_supplier_id'),
  '42501', null,
  'item 11: authenticated still cannot INSERT supplier_branches'
);

select tests.clear_authentication();
select throws_ok(
  $$ select count(*) from suppliers $$,
  '42501', null,
  'item 12: anon still cannot read suppliers'
);
select throws_ok(
  $$ select count(*) from supplier_branches $$,
  '42501', null,
  'item 13: anon still cannot read supplier_branches'
);

select finish();
rollback;
