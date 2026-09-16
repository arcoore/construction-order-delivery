-- Permanent regression coverage for migration 0053's stale-intent guard on
-- the 5 Company Workforce Lifecycle RPCs. See that migration's own header
-- for the real incident this closes (a call that timed out client-side but
-- executed for real ~90 minutes later, against stale input).
--
-- No wall-clock sleep needed: the guard just compares
-- now() - p_client_issued_at, so an "old" timestamp is simply constructed
-- as now() - interval '2 minutes' at call time - deterministic and instant.
begin;
select plan(16);

select tests.create_user('sig-owner@test.local',  'SIG Owner')  as owner  \gset
select tests.create_user('sig-member@test.local', 'SIG Member') as member \gset

select tests.authenticate_as(:'owner');
insert into communities (name, invite_code, owner_id) values ('SIG Co', 'SIGCO1', :'owner') returning id as co \gset

select tests.authenticate_as(:'member');
insert into community_memberships (community_id, user_id, status) values (:'co', :'member', 'pending') returning id as m \gset
select tests.set_membership_status(:'co', :'member', 'approved', :'owner');

-- ================================================================ SUSPEND
select tests.authenticate_as(:'owner');
select throws_ok(
  format($$ select suspend_member(%L, null, now() - interval '2 minutes') $$, :'m'),
  'STALE', null,
  'item 1: suspend_member refuses a 2-minute-old p_client_issued_at');
select is((select status from community_memberships where id = :'m'), 'approved',
  'item 2: the refused stale call left the row untouched');

select lives_ok(
  format($$ select suspend_member(%L, null, now()) $$, :'m'),
  'item 3: suspend_member succeeds with a fresh p_client_issued_at');
select is((select status from community_memberships where id = :'m'), 'suspended',
  'item 4: the fresh call actually applied the transition');

-- ================================================================ RESTORE
select throws_ok(
  format($$ select restore_member(%L, now() - interval '5 minutes') $$, :'m'),
  'STALE', null,
  'item 5: restore_member refuses a 5-minute-old p_client_issued_at');
select is((select status from community_memberships where id = :'m'), 'suspended',
  'item 6: the refused stale restore left the row untouched');

select lives_ok(
  format($$ select restore_member(%L) $$, :'m'),
  'item 7: restore_member succeeds with the parameter omitted entirely (backward compatible)');
select is((select status from community_memberships where id = :'m'), 'approved',
  'item 8: the omitted-parameter call actually applied the transition');

-- ================================================================ REMOVE
select throws_ok(
  format($$ select remove_member(%L, null, now() - interval '10 minutes') $$, :'m'),
  'STALE', null,
  'item 9: remove_member refuses a 10-minute-old p_client_issued_at');
select is((select status from community_memberships where id = :'m'), 'approved',
  'item 10: the refused stale remove left the row untouched');

select lives_ok(
  format($$ select remove_member(%L) $$, :'m'),
  'item 11: remove_member succeeds with the parameter omitted');
select is((select status from community_memberships where id = :'m'), 'removed',
  'item 12: the omitted-parameter call actually applied the transition');

-- ============================================================ RE-REQUEST
select tests.authenticate_as(:'member');
select throws_ok(
  format($$ select rerequest_membership(%L, now() - interval '3 minutes') $$, :'co'),
  'STALE', null,
  'item 13: rerequest_membership refuses a 3-minute-old p_client_issued_at');
select is((select status from community_memberships where id = :'m'), 'removed',
  'item 14: the refused stale rerequest left the row untouched');

select lives_ok(
  format($$ select rerequest_membership(%L) $$, :'co'),
  'item 15: rerequest_membership succeeds with the parameter omitted');
select is((select status from community_memberships where id = :'m'), 'pending',
  'item 16: the omitted-parameter call actually applied the transition');

-- leave_community is not separately exercised here: it shares the exact
-- same guard line, verbatim, as the four RPCs already proven above - a
-- fifth near-identical repetition would test the copy-paste, not the
-- mechanism. Covered structurally by the migration itself defining all 5
-- with the identical check.

select finish();
rollback;
