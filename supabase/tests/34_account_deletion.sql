-- Permanent regression coverage for self-service account deletion
-- (migration 0045): anonymize_own_account() scrubs personal-only data,
-- ends memberships, keeps the profile + display_name for historical
-- records, and refuses while the caller still owns a company.
--
-- The Edge Function's auth.users deletion is not exercised here (no GoTrue
-- in pgTAP); this file covers the SQL side the function depends on.
--
-- The RPC itself must run as the person (auth.uid()); the verification
-- SELECTs run as the superuser session role, since several of the scrubbed
-- tables (client_errors, another user's notifications, a non-member's
-- membership events) are deliberately unreadable by `authenticated`.
begin;
select plan(20);

select tests.create_user('ad-creator@test.local',  'AD Creator')   as creator     \gset
select tests.create_user('ad-owner2@test.local',   'AD Owner Two')  as owner2      \gset
select tests.create_user('ad-worker@test.local',   'AD Worker')     as worker      \gset
select tests.create_user('ad-bystander@test.local','AD Bystander')  as bystander   \gset
select tests.create_user('ad-pending@test.local',  'AD Pending')    as pendinguser \gset

select tests.authenticate_as(:'creator');
insert into communities (name, invite_code, owner_id) values ('AD Co', 'ADCO01', :'creator') returning id as co \gset
insert into sites (community_id, name, created_by_id) values (:'co', 'AD Site', :'creator') returning id as site \gset

select tests.authenticate_as(:'worker');
insert into community_memberships (community_id, user_id, status) values (:'co', :'worker', 'pending') returning id as m_worker \gset
select tests.set_membership_status(:'co', :'worker', 'approved', :'creator');
select tests.authenticate_as(:'bystander');
insert into community_memberships (community_id, user_id, status) values (:'co', :'bystander', 'pending') returning id as m_bystander \gset
select tests.set_membership_status(:'co', :'bystander', 'approved', :'creator');
select tests.authenticate_as(:'owner2');
insert into community_memberships (community_id, user_id, status) values (:'co', :'owner2', 'pending') returning id as m_owner2 \gset
select tests.set_membership_status(:'co', :'owner2', 'approved', :'creator');
select tests.authenticate_as(:'pendinguser');
insert into community_memberships (community_id, user_id, status) values (:'co', :'pendinguser', 'pending') returning id as m_pending \gset

select tests.authenticate_as(:'creator');
insert into site_memberships (site_id, community_id, user_id, added_by_id) values (:'site', :'co', :'worker', :'creator');
insert into buyer_grants (community_id, user_id, granted_by_id) values (:'co', :'worker', :'creator');
insert into owner_grants (community_id, user_id, granted_by_id) values (:'co', :'owner2', :'creator');

-- Seed personal data as the superuser role (`notifications` / `client_errors`
-- have no INSERT/SELECT grant for `authenticated`).
reset role;
insert into notifications (recipient_user_id, type, category, title, message)
  values (:'worker', 'order_delivered', 'deliveryUpdates', 'x', 'x'),
         (:'bystander', 'order_delivered', 'deliveryUpdates', 'keep', 'keep');
insert into notification_preferences (user_id, order_updates) values (:'worker', false);
insert into client_errors (user_id, message) values (:'worker', 'boom');

-- ================================================================ ANON
select tests.clear_authentication();
select throws_ok($$ select anonymize_own_account() $$, '42501', null,
  'item 1: an unauthenticated caller cannot run anonymize_own_account');

-- ================================================================ OWNER BLOCKED
select tests.authenticate_as(:'creator');
select throws_ok($$ select anonymize_own_account() $$, '42501', null,
  'item 2: the company creator is refused - must transfer/delete the company first');
reset role;
select is(
  (select count(*)::int from profiles where id = :'creator' and deleted_at is not null),
  0, 'item 3: the refused creator was not marked deleted');

-- ================================================================ WORKER DELETES
select tests.authenticate_as(:'worker');
select lives_ok($$ select anonymize_own_account() $$, 'item 4: an ordinary member can delete their account');
reset role;

select is(
  (select display_name from profiles where id = :'worker'),
  'AD Worker', 'item 5: the display name is kept on the profile');
select isnt(
  (select deleted_at from profiles where id = :'worker'),
  null, 'item 6: profiles.deleted_at is set');
select is(
  (select count(*)::int from profiles where id = :'worker'),
  1, 'item 7: the profile row itself is kept (name survives on histories)');

select is(
  (select status from community_memberships where id = :'m_worker'),
  'left', 'item 8: the active membership is ended');
select is(
  (select status_reason from community_memberships where id = :'m_worker'),
  'Account deleted', 'item 9: with the account-deleted reason');

select is(
  (select count(*)::int from notifications where recipient_user_id = :'worker'),
  0, 'item 10: their notifications are deleted');
select is(
  (select count(*)::int from notification_preferences where user_id = :'worker'),
  0, 'item 11: their notification preferences are deleted');
select is(
  (select count(*)::int from site_memberships where user_id = :'worker'),
  0, 'item 12: their site memberships are deleted');
select is(
  (select count(*)::int from buyer_grants where user_id = :'worker'),
  0, 'item 13: their buyer grant is deleted');
select is(
  (select count(*)::int from client_errors where user_id = :'worker'),
  0, 'item 14: their browser error reports are deleted');

select is(
  (select type || ':' || from_status || '->' || to_status || ':' || reason
     from community_membership_events
     where membership_id = :'m_worker' order by created_at desc limit 1),
  'member_left:approved->left:Account deleted',
  'item 15: an audit event records the departure');
select is(
  (select count(*)::int from notifications
     where recipient_user_id = :'creator' and type = 'member_left'
       and message = 'AD Worker deleted their SiteStock account.'),
  1, 'item 16: the company owner is notified');

select is(
  (select count(*)::int from notifications where recipient_user_id = :'bystander' and message = 'keep'),
  1, 'item 17: another member''s data is untouched');

-- ================================================================ IDEMPOTENT
select tests.authenticate_as(:'worker');
select lives_ok($$ select anonymize_own_account() $$,
  'item 18: a second call (Edge Function retry) is a harmless no-op');

-- ================================================================ PENDING ROW
select tests.authenticate_as(:'pendinguser');
select anonymize_own_account();
reset role;
select is(
  (select count(*)::int from community_memberships where id = :'m_pending'),
  0, 'item 19: a still-pending join request is removed, not left dangling');

-- ================================================================ GRANTED OWNER
-- owner2 is a granted owner, NOT the creator (communities.owner_id is the
-- creator), so they are allowed to delete; their owner grant is stripped.
select tests.authenticate_as(:'owner2');
select anonymize_own_account();
reset role;
select is(
  (select count(*)::int from owner_grants where user_id = :'owner2'),
  0, 'item 20: a granted (non-creator) owner can delete; their owner grant is removed');

select finish();
rollback;
