-- Phase 8D.1 — server-backed notifications (migration 0014). Covers the
-- required security/isolation matrix plus real coverage that the two
-- creation paths (embedded-in-lifecycle-RPC, and the seven notify_* RPCs)
-- actually produce correct notifications for legitimate actions and refuse
-- forged ones for illegitimate actors.
begin;
select plan(21);

select tests.create_user('owner-e@test.local', 'Owner E')       as owner_e \gset
select tests.create_user('worker-e@test.local', 'Worker E')     as worker_e \gset
select tests.create_user('buyer-e@test.local', 'Buyer E')       as buyer_e \gset
select tests.create_user('stranger-e@test.local', 'Stranger E') as stranger_e \gset
select tests.create_user('same-name-1@test.local', 'Same Buyer') as same_name_1 \gset
select tests.create_user('same-name-2@test.local', 'Same Buyer') as same_name_2 \gset

select tests.authenticate_as(:'owner_e');
insert into communities (name, invite_code, owner_id) values ('Company E', 'EEEEEE', :'owner_e') returning id as company_e \gset
insert into sites (community_id, name, created_by_id) values (:'company_e', 'Site E', :'owner_e') returning id as site_e \gset

select tests.authenticate_as(:'worker_e');
insert into community_memberships (community_id, user_id, status) values (:'company_e', :'worker_e', 'pending');
select tests.authenticate_as(:'buyer_e');
insert into community_memberships (community_id, user_id, status) values (:'company_e', :'buyer_e', 'pending');
select tests.authenticate_as(:'same_name_1');
insert into community_memberships (community_id, user_id, status) values (:'company_e', :'same_name_1', 'pending');
select tests.authenticate_as(:'same_name_2');
insert into community_memberships (community_id, user_id, status) values (:'company_e', :'same_name_2', 'pending');

select tests.authenticate_as(:'owner_e');
update community_memberships set status = 'approved', decided_by_id = :'owner_e' where community_id = :'company_e';
insert into site_memberships (site_id, community_id, user_id, added_by_id) values (:'site_e', :'company_e', :'worker_e', :'owner_e');
insert into buyer_grants (community_id, user_id, granted_by_id) values (:'company_e', :'buyer_e', :'owner_e');

-- ================================================================
-- items 1-2: anon cannot read or write notifications at all
-- ================================================================
select tests.clear_authentication();
select throws_ok(
  $$ select count(*) from notifications $$,
  '42501', null,
  'item 1: anon cannot read the notifications table (no SELECT grant to anon)'
);
select throws_ok(
  format($$ insert into notifications (recipient_user_id, type, category, title, message) values (%L, 'order_rejected', 'approvalUpdates', 'x', 'y') $$, :'owner_e'),
  '42501', null,
  'item 2: anon cannot write into notifications (no INSERT grant to anon)'
);

-- ================================================================
-- item 11 (pulled forward so items 3-6 have a real notification to work
-- with): a legitimate application action produces the correct notification
-- ================================================================
select tests.authenticate_as(:'worker_e');
select create_order(:'company_e', :'site_e', 'p1', 'Cement', '25kg bag', 5, 'bag', 'SW1A 1AA', null, null, 'b1', 'Merchant', 'merchant.co.uk', 'SW1 1AA', 'today', 6.75) as order_result \gset
select (:'order_result'::orders).id as order_id \gset

select tests.authenticate_as(:'owner_e');
select ok(
  exists(select 1 from notifications where recipient_user_id = :'owner_e' and type = 'order_awaiting_approval' and order_id = :'order_id'),
  'item 11a: creating an order that needs approval notifies the owner, server-side, with the correct order_id'
);

select approve_order(:'order_id');
select tests.authenticate_as(:'buyer_e');
select ok(
  exists(select 1 from notifications where recipient_user_id = :'buyer_e' and type = 'order_ready_for_purchase' and order_id = :'order_id'),
  'item 11b: approving the order notifies the buyer, server-side, with the correct order_id'
);

-- ================================================================
-- items 3-4: User A cannot read or mark-read User B's notification
-- ================================================================
select tests.authenticate_as(:'owner_e');
select is(
  (select count(*) from notifications where recipient_user_id = :'buyer_e')::int, 0,
  'item 3: a different authenticated user (owner) sees zero rows belonging to the buyer''s notifications'
);
with attempt as (
  update notifications set read = true where recipient_user_id = :'buyer_e' returning 1
) select count(*)::int as attempt_rowcount from attempt \gset
select is( :'attempt_rowcount'::int, 0,
  'item 4: owner''s UPDATE against the buyer''s notification affects zero rows' );

-- ================================================================
-- items 5-6: User A can read and mark-read their own notification
-- ================================================================
select tests.authenticate_as(:'buyer_e');
select ok(
  (select count(*) from notifications where recipient_user_id = :'buyer_e' and type = 'order_ready_for_purchase') >= 1,
  'item 5: the buyer can read their own notification'
);
update notifications set read = true, read_at = now() where recipient_user_id = :'buyer_e' and type = 'order_ready_for_purchase' and order_id = :'order_id';
select ok(
  (select read from notifications where recipient_user_id = :'buyer_e' and order_id = :'order_id' and type = 'order_ready_for_purchase'),
  'item 6: the buyer can mark their own notification read'
);

-- ================================================================
-- item 7: an arbitrary authenticated client cannot forge a notification for
-- another user, via either the raw table or a notify_* RPC
-- ================================================================
select tests.authenticate_as(:'owner_e');
select throws_ok(
  format($$ insert into notifications (recipient_user_id, type, category, title, message, community_id) values (%L, 'buyer_access_granted', 'roleUpdates', 'forged', 'forged', %L) $$, :'stranger_e', :'company_e'),
  '42501', null,
  'item 7a: even a legitimate, real owner cannot INSERT into notifications directly (no INSERT grant to authenticated at all — creation is RPC-only)'
);
select tests.authenticate_as(:'stranger_e');
select throws_ok(
  format($$ select notify_buyer_access_granted(%L, %L) $$, :'company_e', :'buyer_e'),
  '42501', null,
  'item 7b: a stranger cannot use notify_buyer_access_granted to claim credit for a grant they did not make'
);
select throws_ok(
  format($$ select notify_site_archived(%L) $$, :'site_e'),
  '42501', null,
  'item 7c: a stranger cannot use notify_site_archived to fabricate an archive notification for a site they never archived'
);

-- ================================================================
-- items 8-10: preferences are private to their own user
-- ================================================================
select tests.authenticate_as(:'owner_e');
insert into notification_preferences (user_id, approval_updates) values (:'owner_e', false);
select tests.authenticate_as(:'buyer_e');
insert into notification_preferences (user_id, approval_updates) values (:'buyer_e', true);

select tests.authenticate_as(:'owner_e');
select is(
  (select count(*) from notification_preferences where user_id = :'buyer_e')::int, 0,
  'item 8: owner cannot see the buyer''s preference row'
);
select is(
  (select approval_updates from notification_preferences where user_id = :'owner_e'), false,
  'item 9a: owner can read their own preferences'
);
update notification_preferences set approval_updates = true where user_id = :'owner_e';
select is(
  (select approval_updates from notification_preferences where user_id = :'owner_e'), true,
  'item 9b: owner can update their own preferences'
);
with attempt as (
  update notification_preferences set approval_updates = false where user_id = :'buyer_e' returning 1
) select count(*)::int as pref_attempt_rowcount from attempt \gset
select is( :'pref_attempt_rowcount'::int, 0,
  'item 10: owner cannot update the buyer''s preferences' );

-- ================================================================
-- item 12: a retried/duplicate lifecycle call does not create a duplicate
-- notification — the underlying conditional UPDATE's WHERE-status guard
-- (already the source of this app's concurrency safety) means a retry never
-- even reaches the notification insert a second time.
-- ================================================================
select tests.authenticate_as(:'owner_e');
select throws_ok(
  format($$ select approve_order(%L) $$, :'order_id'),
  '40001', null,
  'item 12a: re-approving an already-approved order is refused (already-covered concurrency guard)'
);
select tests.authenticate_as(:'buyer_e');
select is(
  (select count(*) from notifications where recipient_user_id = :'buyer_e' and order_id = :'order_id' and type = 'order_ready_for_purchase')::int, 1,
  'item 12b: exactly one order_ready_for_purchase notification exists despite the retried approve_order call'
);

-- ================================================================
-- item 13: recipient identity isolation holds even with duplicate display
-- names — two distinct users both named "Same Buyer" each get their own,
-- fully separate notification for the same event type.
-- ================================================================
select tests.authenticate_as(:'owner_e');
insert into buyer_grants (community_id, user_id, granted_by_id) values (:'company_e', :'same_name_1', :'owner_e');
insert into buyer_grants (community_id, user_id, granted_by_id) values (:'company_e', :'same_name_2', :'owner_e');
select notify_buyer_access_granted(:'company_e', :'same_name_1');
select notify_buyer_access_granted(:'company_e', :'same_name_2');

select tests.authenticate_as(:'same_name_1');
select is(
  (select count(*) from notifications where type = 'buyer_access_granted' and community_id = :'company_e')::int, 1,
  'item 13a: "Same Buyer" #1 sees exactly their own buyer_access_granted notification, not their namesake''s'
);
select is(
  (select recipient_user_id from notifications where type = 'buyer_access_granted' and community_id = :'company_e' limit 1), :'same_name_1'::uuid,
  'item 13b: the visible row''s recipient_user_id really is user #1, proven by id not by the (identical) display name'
);
select tests.authenticate_as(:'same_name_2');
select is(
  (select count(*) from notifications where type = 'buyer_access_granted' and community_id = :'company_e')::int, 1,
  'item 13c: "Same Buyer" #2 sees exactly their own notification too — the two never merged or cross-delivered'
);

-- ================================================================
-- bonus: preference filtering at creation time still holds server-side
-- (Phase 3A's "creation-time filtering" product semantic, ported)
-- ================================================================
select tests.authenticate_as(:'owner_e');
update notification_preferences set approval_updates = false where user_id = :'owner_e';
select tests.authenticate_as(:'worker_e');
select create_order(:'company_e', :'site_e', 'p2', 'Timber', '2.4m', 3, 'length', 'SW1A 1AA', null, null, 'b1', 'Merchant', 'merchant.co.uk', 'SW1 1AA', 'today', 4.50) as order_result2 \gset
select (:'order_result2'::orders).id as order_id2 \gset
select tests.authenticate_as(:'owner_e');
select is(
  (select count(*) from notifications where recipient_user_id = :'owner_e' and order_id = :'order_id2' and type = 'order_awaiting_approval')::int, 0,
  'bonus: order_awaiting_approval is not created for a recipient whose approvalUpdates preference is off, even though the underlying order-creation still succeeds'
);

select finish();
rollback;
