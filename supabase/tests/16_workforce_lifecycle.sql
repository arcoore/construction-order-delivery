-- Permanent regression coverage for the Company Workforce Lifecycle
-- (migration 0023): suspend_member / restore_member / remove_member /
-- leave_community / rerequest_membership, the grant+site cleanup rules,
-- the can_purchase_for_site tightening, and the four new notification
-- types. Same shape and discipline as 15_join_request_decision.sql.
--
-- CONCURRENCY NOTE: the state-machine guards below (an already-decided
-- transition refused with 40001) are proven within pgTAP's single-
-- transaction sequencing. A genuine two-connection race on remove_member
-- was run separately (raw psql), matching this project's precedent for
-- start_purchase / claim_delivery / decide_join_request.
begin;
select plan(50);

select tests.create_user('wf-creator@test.local', 'WF Creator')   as creator \gset
select tests.create_user('wf-owner2@test.local',  'WF Owner Two')  as owner2 \gset
select tests.create_user('wf-worker@test.local',  'WF Worker')     as worker \gset
select tests.create_user('wf-buyer@test.local',   'WF Buyer')      as buyer \gset
select tests.create_user('wf-driver@test.local',  'WF Driver')     as driver \gset
select tests.create_user('wf-stranger@test.local','WF Stranger')   as stranger \gset

select tests.authenticate_as(:'creator');
insert into communities (name, invite_code, owner_id) values ('WF Co', 'WFCO01', :'creator') returning id as co \gset
insert into sites (community_id, name, created_by_id) values (:'co', 'WF Site', :'creator') returning id as site \gset
-- The creator also holds a (normally-unusual) self-membership row so the
-- "creator cannot be suspended/removed" guards have something to target.
insert into community_memberships (community_id, user_id, status) values (:'co', :'creator', 'pending') returning id as m_creator \gset
select tests.set_membership_status(:'co', :'creator', 'approved', :'creator');

select tests.authenticate_as(:'worker');
insert into community_memberships (community_id, user_id, status) values (:'co', :'worker', 'pending') returning id as m_worker \gset
select tests.set_membership_status(:'co', :'worker', 'approved', :'creator');
select tests.authenticate_as(:'buyer');
insert into community_memberships (community_id, user_id, status) values (:'co', :'buyer', 'pending') returning id as m_buyer \gset
select tests.set_membership_status(:'co', :'buyer', 'approved', :'creator');
select tests.authenticate_as(:'driver');
insert into community_memberships (community_id, user_id, status) values (:'co', :'driver', 'pending') returning id as m_driver \gset
select tests.set_membership_status(:'co', :'driver', 'approved', :'creator');
select tests.authenticate_as(:'owner2');
insert into community_memberships (community_id, user_id, status) values (:'co', :'owner2', 'pending') returning id as m_owner2 \gset
select tests.set_membership_status(:'co', :'owner2', 'approved', :'creator');
select tests.authenticate_as(:'stranger');
insert into community_memberships (community_id, user_id, status) values (:'co', :'stranger', 'pending') returning id as m_stranger \gset
select tests.set_membership_status(:'co', :'stranger', 'declined', :'creator');

select tests.authenticate_as(:'creator');
insert into site_memberships (site_id, community_id, user_id, added_by_id) values
  (:'site', :'co', :'worker', :'creator'),
  (:'site', :'co', :'buyer', :'creator');
insert into buyer_grants (community_id, user_id, granted_by_id) values (:'co', :'buyer', :'creator');
insert into owner_grants (community_id, user_id, granted_by_id) values (:'co', :'owner2', :'creator');

-- ================================================================ SUSPEND
select tests.authenticate_as(:'worker');
select throws_ok(format($$ select suspend_member(%L) $$, :'m_buyer'), '42501', null,
  'item 1: a non-owner cannot suspend a member');

select tests.authenticate_as(:'creator');
select is((suspend_member(:'m_buyer', 'perf review')).status, 'suspended',
  'item 2: the creator suspends the buyer -> status suspended');
select ok((select status_changed_by_id = :'creator' and status_reason = 'perf review'
           from community_memberships where id = :'m_buyer'),
  'item 3: suspend stamps status_changed_by_id + reason');
select ok(not is_approved_member(:'co', :'buyer'),
  'item 4: a suspended member is not is_approved_member');
select ok(exists(select 1 from buyer_grants where community_id = :'co' and user_id = :'buyer'),
  'item 5: suspend LEAVES the buyer grant in place (dormant)');
select ok(exists(select 1 from site_memberships where community_id = :'co' and user_id = :'buyer'),
  'item 6: suspend LEAVES site memberships in place');
select tests.authenticate_as(:'buyer');
select ok(not can_purchase_for_site(:'site', :'co', :'buyer'),
  'item 7: a suspended buyer cannot purchase (can_purchase_for_site now requires approved membership)');

select tests.authenticate_as(:'creator');
select throws_ok(format($$ select suspend_member(%L) $$, :'m_buyer'), '40001', null,
  'item 8: suspending an already-suspended member is refused (state guard)');
select is((select count(*) from community_membership_events where membership_id = :'m_buyer' and type = 'member_suspended')::int, 1,
  'item 9: exactly one member_suspended event');
select tests.authenticate_as(:'buyer');
select is((select count(*) from notifications where recipient_user_id = :'buyer' and type = 'membership_suspended')::int, 1,
  'item 10: exactly one membership_suspended notification');
select is((select message from notifications where recipient_user_id = :'buyer' and type = 'membership_suspended'),
  'Your access to WF Co has been suspended.', 'item 11: suspension notification wording');

select tests.authenticate_as(:'owner2');
select throws_ok(format($$ select suspend_member(%L) $$, :'m_creator'), '42501', null,
  'item 12: nobody can suspend the company creator');
select throws_ok(format($$ select suspend_member(%L) $$, :'m_owner2'), '42501', null,
  'item 13: an owner cannot suspend themselves');
select throws_ok(format($$ select suspend_member(%L) $$, :'m_creator'), '42501', null,
  'item 14: a granted owner is still blocked from suspending the creator');

-- ================================================================ RESTORE
select tests.authenticate_as(:'worker');
select throws_ok(format($$ select restore_member(%L) $$, :'m_buyer'), '42501', null,
  'item 15: a non-owner cannot restore a member');
select tests.authenticate_as(:'creator');
select is((restore_member(:'m_buyer')).status, 'approved',
  'item 16: the creator restores the suspended buyer -> approved');
select ok(is_approved_member(:'co', :'buyer'), 'item 17: restored member is_approved_member again');
select tests.authenticate_as(:'buyer');
select ok(can_purchase_for_site(:'site', :'co', :'buyer'),
  'item 18: the restored buyer can purchase again (grant + site were never removed)');
select tests.authenticate_as(:'creator');
select throws_ok(format($$ select restore_member(%L) $$, :'m_buyer'), '40001', null,
  'item 19: restoring an already-approved member is refused');
select tests.authenticate_as(:'buyer');
select is((select count(*) from notifications where recipient_user_id = :'buyer' and type = 'membership_restored')::int, 1,
  'item 20: exactly one membership_restored notification');
select is((select message from notifications where recipient_user_id = :'buyer' and type = 'membership_restored'),
  'Your access to WF Co has been restored.', 'item 21: restore notification wording');
select is((select count(*) from community_membership_events where membership_id = :'m_buyer' and type = 'member_restored')::int, 1,
  'item 22: exactly one member_restored event');

-- ================================================================ REMOVE
select tests.authenticate_as(:'worker');
select throws_ok(format($$ select remove_member(%L) $$, :'m_buyer'), '42501', null,
  'item 23: a non-owner cannot remove a member');
select tests.authenticate_as(:'owner2');
select throws_ok(format($$ select remove_member(%L) $$, :'m_creator'), '42501', null,
  'item 24: the creator cannot be removed');
select throws_ok(format($$ select remove_member(%L) $$, :'m_owner2'), '42501', null,
  'item 25: an owner cannot remove themselves (leave, not remove)');

select tests.authenticate_as(:'creator');
select is((remove_member(:'m_buyer', 'left IRL')).status, 'removed',
  'item 26: the creator removes the buyer -> status removed');
select is((select count(*) from buyer_grants where community_id = :'co' and user_id = :'buyer')::int, 0,
  'item 27: remove DELETES the buyer grant');
select is((select count(*) from site_memberships where community_id = :'co' and user_id = :'buyer')::int, 0,
  'item 28: remove DELETES all site memberships');
select is((select count(*) from buyer_requests where community_id = :'co' and user_id = :'buyer')::int, 0,
  'item 29: remove DELETES any buyer request');
select tests.authenticate_as(:'buyer');
select is((select count(*) from notifications where recipient_user_id = :'buyer' and type = 'membership_removed')::int, 1,
  'item 30: exactly one membership_removed notification');
select is((select message from notifications where recipient_user_id = :'buyer' and type = 'membership_removed'),
  'You have been removed from WF Co.', 'item 31: removal notification wording');
select tests.authenticate_as(:'creator');
select is((select (meta->>'buyerGrantRevoked')::boolean from community_membership_events where membership_id = :'m_buyer' and type = 'member_removed'), true,
  'item 32: the member_removed event meta records the buyer grant was revoked');
select throws_ok(format($$ select remove_member(%L) $$, :'m_stranger'), '40001', null,
  'item 33: removing an already-declined membership is refused (state guard)');

select is((remove_member(:'m_owner2')).status, 'removed', 'item 34: the creator removes a granted owner');
select is((select count(*) from owner_grants where community_id = :'co' and user_id = :'owner2')::int, 0,
  'item 35: removing an owner also revokes their owner grant');
select is((restore_member(:'m_buyer')).status, 'approved', 'item 36: a removed member can be restored to approved');
select is((select count(*) from buyer_grants where community_id = :'co' and user_id = :'buyer')::int, 0,
  'item 37: restoring a removed member does NOT bring back their stripped grants');

-- ================================================================ LEAVE
select tests.authenticate_as(:'creator');
select throws_ok(format($$ select leave_community(%L) $$, :'co'), '42501', null,
  'item 38: the company creator cannot leave their own company');
select tests.authenticate_as(:'stranger');
select throws_ok(format($$ select leave_community(%L) $$, :'co'), '40001', null,
  'item 39: a non-approved (declined) person cannot leave');

select tests.authenticate_as(:'worker');
select is((leave_community(:'co')).status, 'left', 'item 40: an approved member leaves -> status left');
select is((select count(*) from site_memberships where community_id = :'co' and user_id = :'worker')::int, 0,
  'item 41: leaving deletes the members own site memberships');
select tests.authenticate_as(:'creator');
select is((select count(*) from notifications where recipient_user_id = :'creator' and type = 'member_left')::int, 1,
  'item 42: the owner is notified that a member left');
select is((select message from notifications where recipient_user_id = :'creator' and type = 'member_left'),
  'WF Worker left WF Co.', 'item 43: member_left notification wording');
select is((select count(*) from community_membership_events where membership_id = :'m_worker' and type = 'member_left')::int, 1,
  'item 44: exactly one member_left event');

select tests.authenticate_as(:'creator');
insert into owner_grants (community_id, user_id, granted_by_id) values (:'co', :'driver', :'creator');
select tests.authenticate_as(:'driver');
select is((leave_community(:'co')).status, 'left', 'item 45: a granted owner can leave');
select is((select count(*) from owner_grants where community_id = :'co' and user_id = :'driver')::int, 0,
  'item 46: a leaving owners owner grant is dropped');

-- ================================================================ RE-REQUEST
select tests.authenticate_as(:'worker');
select is((rerequest_membership(:'co')).status, 'pending', 'item 47: a member who left can re-request -> pending');
select ok((select decided_at is null and decided_by_id is null from community_memberships where id = :'m_worker'),
  'item 48: re-request clears the prior decision');
select throws_ok(format($$ select rerequest_membership(%L) $$, :'co'), '40001', null,
  'item 49: re-requesting while already pending is refused');
select tests.authenticate_as(:'stranger');
select is((rerequest_membership(:'co')).status, 'pending', 'item 50: a declined member can re-request');

select finish();
rollback;
