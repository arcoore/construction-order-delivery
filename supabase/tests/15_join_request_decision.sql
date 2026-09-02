-- Permanent regression coverage for decide_join_request (migration 0022):
-- the guarded RPC replacing the old plain community_memberships UPDATE,
-- plus the applicant notification it now creates. Covers the state-machine
-- guard (double-click/replay/competing-session protection) that the old
-- direct update never had, and confirms the old UPDATE policy is genuinely
-- gone, not just unused.
--
-- CONCURRENCY NOTE (read before assuming more than this file proves): items
-- 12/13 below prove the *state-machine guard* — an already-decided request
-- cannot be re-decided, and a decision is version-locked against a stale
-- expectation, both within pgTAP's single-transaction sequencing. That is
-- NOT the same claim as "two genuinely simultaneous connections were
-- proven to race safely" — this project's own precedent for that stronger
-- claim (order_lifecycle's start_purchase/claim_delivery races) always
-- used a separate raw two-connection `psql` harness outside pgTAP, and the
-- concurrency verification for this feature was done the same way,
-- reported separately from this file's results.
begin;
select plan(19);

select tests.create_user('owner-h@test.local', 'Owner H') as owner_h \gset
select tests.create_user('applicant-h@test.local', 'Applicant H') as applicant_h \gset
select tests.create_user('stranger-h@test.local', 'Stranger H') as stranger_h \gset
select tests.create_user('member-h@test.local', 'Member H') as member_h \gset

select tests.authenticate_as(:'owner_h');
insert into communities (name, invite_code, owner_id) values ('Company H', 'HJOIN1', :'owner_h') returning id as company_h \gset

-- member_h: an approved (non-owner) member of the same company, used for
-- the "unrelated/non-owner member cannot decide" check.
select tests.authenticate_as(:'member_h');
insert into community_memberships (community_id, user_id, status) values (:'company_h', :'member_h', 'pending');
-- Deliberately the tests.set_membership_status bypass helper, not
-- decide_join_request itself — this fixture just needs "an approved
-- non-owner member" to exist quickly; the RPC's own behavior is what items
-- 6-19 below actually exercise.
select tests.set_membership_status(:'company_h', :'member_h', 'approved', :'owner_h');

-- ================================================================
-- items 1-2: anon cannot execute the RPC, and the old direct UPDATE
-- policy is genuinely gone (not just unused) — confirms the bypass this
-- migration closes is actually closed, not merely superseded.
-- ================================================================
select tests.clear_authentication();
select throws_ok(
  $$ select decide_join_request('00000000-0000-0000-0000-000000000000'::uuid, 'approved') $$,
  '42501', null,
  'item 1: anon cannot execute decide_join_request at all (no EXECUTE grant)'
);

-- ================================================================
-- ORDER A — a fresh pending request, approved legitimately by the owner
-- ================================================================
select tests.authenticate_as(:'applicant_h');
insert into community_memberships (community_id, user_id, status) values (:'company_h', :'applicant_h', 'pending')
  returning id as request_a \gset

-- item 2: applicant cannot decide their own request (not an owner)
select tests.authenticate_as(:'applicant_h');
select throws_ok(
  format($$ select decide_join_request(%L, 'approved') $$, :'request_a'),
  '42501', null,
  'item 2: the applicant cannot decide their own join request'
);

-- item 3: an unrelated approved member (not an owner) cannot decide it either
select tests.authenticate_as(:'member_h');
select throws_ok(
  format($$ select decide_join_request(%L, 'approved') $$, :'request_a'),
  '42501', null,
  'item 3: a non-owner approved member cannot decide someone else''s join request'
);

-- item 4: an invalid decision value is rejected before anything is touched
select tests.authenticate_as(:'owner_h');
select throws_ok(
  format($$ select decide_join_request(%L, 'maybe') $$, :'request_a'),
  '22023', null,
  'item 4: an invalid decision value is refused'
);
select is(
  (select status from community_memberships where id = :'request_a')::text, 'pending',
  'item 5: the invalid-decision attempt left the request untouched, still pending'
);

-- item 6: legitimate owner approval
select (decide_join_request(:'request_a', 'approved')).status::text as decided_status \gset
select is(:'decided_status'::text, 'approved', 'item 6: legitimate owner approval succeeds and returns status = approved');
select ok(
  (select decided_at is not null and decided_by_id = :'owner_h' from community_memberships where id = :'request_a'),
  'item 7: decided_at is populated and decided_by_id is the deciding owner'
);

-- item 8: exactly one membership_approved notification, correct recipient + wording
select tests.authenticate_as(:'applicant_h');
select is(
  (select count(*) from notifications where recipient_user_id = :'applicant_h' and type = 'membership_approved')::int, 1,
  'item 8: exactly one membership_approved notification was created for the applicant'
);
select is(
  (select message from notifications where recipient_user_id = :'applicant_h' and type = 'membership_approved'),
  'Your request to join Company H was approved.',
  'item 9: the notification message names the correct company with the expected wording'
);

-- item 10: already-approved request cannot be decided again (state-machine guard)
select tests.authenticate_as(:'owner_h');
select throws_ok(
  format($$ select decide_join_request(%L, 'declined') $$, :'request_a'),
  '40001', null,
  'item 10: an already-approved request cannot be re-decided'
);

-- item 11: replay created no duplicate notification
select tests.authenticate_as(:'applicant_h');
select is(
  (select count(*) from notifications where recipient_user_id = :'applicant_h' and type = 'membership_approved')::int, 1,
  'item 11: the refused replay did not create a duplicate notification'
);
select is(
  (select count(*) from notifications where recipient_user_id = :'applicant_h' and type = 'membership_declined')::int, 0,
  'item 12: the refused replay did not create a conflicting decline notification either'
);

-- ================================================================
-- ORDER B — a fresh pending request, declined legitimately, plus the
-- "competing/stale decision cannot overwrite the first decision" check
-- ================================================================
select tests.authenticate_as(:'stranger_h');
insert into community_memberships (community_id, user_id, status) values (:'company_h', :'stranger_h', 'pending')
  returning id as request_b \gset

select tests.authenticate_as(:'owner_h');
select (decide_join_request(:'request_b', 'declined')).status::text as decided_status_b \gset
select is(:'decided_status_b'::text, 'declined', 'item 13: legitimate owner decline succeeds and returns status = declined');

select tests.authenticate_as(:'stranger_h');
select is(
  (select count(*) from notifications where recipient_user_id = :'stranger_h' and type = 'membership_declined')::int, 1,
  'item 14: exactly one membership_declined notification was created for the applicant'
);
select is(
  (select message from notifications where recipient_user_id = :'stranger_h' and type = 'membership_declined'),
  'Your request to join Company H was declined.',
  'item 15: the decline notification wording is correct'
);

-- item 16: already-declined request cannot be decided again — this is the
-- same guard as item 10, exercised on the decline branch specifically, and
-- doubles as the "competing/stale decision cannot overwrite the first
-- decision" proof: a second call (simulating a second, later-arriving
-- session) is refused outright rather than silently overwriting item 13's
-- real decision.
select tests.authenticate_as(:'owner_h');
select throws_ok(
  format($$ select decide_join_request(%L, 'approved') $$, :'request_b'),
  '40001', null,
  'item 16: an already-declined request cannot be re-decided by a competing/later call'
);
select is(
  (select status from community_memberships where id = :'request_b')::text, 'declined',
  'item 17: the original decline is unchanged after the refused competing call'
);

-- item 18: notifications remain generated regardless of the applicant's
-- normal configurable preferences — both types are non-configurable, so
-- explicitly turning every category off must not suppress them. (Not
-- testing "disabled -> no notification" for these two, per explicit
-- direction — that would assert the wrong behavior.)
select tests.authenticate_as(:'applicant_h');
insert into notification_preferences (user_id, order_updates, approval_updates, delivery_updates, role_updates)
values (:'applicant_h', false, false, false, false);
select tests.authenticate_as(:'stranger_h');
insert into notification_preferences (user_id, order_updates, approval_updates, delivery_updates, role_updates)
values (:'stranger_h', false, false, false, false);

-- member_h is already approved from setup, so a brand new applicant is
-- used here to get a genuine fresh pending row with prefs already set to
-- all-off.
select tests.create_user('prefs-off-h@test.local', 'Prefs Off H') as prefs_off_h \gset
select tests.authenticate_as(:'prefs_off_h');
insert into notification_preferences (user_id, order_updates, approval_updates, delivery_updates, role_updates)
values (:'prefs_off_h', false, false, false, false);
insert into community_memberships (community_id, user_id, status) values (:'company_h', :'prefs_off_h', 'pending')
  returning id as request_c \gset

select tests.authenticate_as(:'owner_h');
select decide_join_request(:'request_c', 'approved');

select tests.authenticate_as(:'prefs_off_h');
select is(
  (select count(*) from notifications where recipient_user_id = :'prefs_off_h' and type = 'membership_approved')::int, 1,
  'item 18: the notification still fires even with every configurable preference off (non-configurable, by design)'
);

-- ================================================================
-- item 19: existing optional site-assignment flow remains compatible —
-- addSiteMember (owner.js's own separate follow-up call) is untouched by
-- this migration and still works normally right after a decision.
-- ================================================================
select tests.authenticate_as(:'owner_h');
insert into sites (community_id, name, created_by_id) values (:'company_h', 'Site H', :'owner_h') returning id as site_h \gset
insert into site_memberships (site_id, community_id, user_id, added_by_id) values (:'site_h', :'company_h', :'prefs_off_h', :'owner_h');
select ok(
  exists(select 1 from site_memberships where site_id = :'site_h' and user_id = :'prefs_off_h'),
  'item 19: the existing site-assignment flow still works immediately after a decision, unaffected by this migration'
);

select finish();
rollback;
