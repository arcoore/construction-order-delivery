-- Phase 8D.1 hardening — expanded executable coverage requested by the
-- pre-commit audit: every non-order notification/mutation path (success +
-- forgery/refusal where applicable), plus a real lifecycle progression
-- through every order-lifecycle notification type at least once. This file
-- is additive to 06_notification_backend.sql (which keeps the core
-- security/isolation matrix — anon refusal, cross-user isolation, raw
-- INSERT forgery, preference privacy, retry-safety, identity isolation) —
-- kept in its own file rather than growing 06 further, matching this
-- project's "pgTAP tests, one concern per file" convention.
begin;
select plan(45);

select tests.create_user('owner-f@test.local', 'Owner F')     as owner_f \gset
select tests.create_user('worker-f@test.local', 'Worker F')   as worker_f \gset
select tests.create_user('buyer-f@test.local', 'Buyer F')     as buyer_f \gset
select tests.create_user('driver-f@test.local', 'Driver F')   as driver_f \gset
select tests.create_user('buyer2-f@test.local', 'Buyer F2')   as buyer2_f \gset
select tests.create_user('stranger-f@test.local', 'Stranger F') as stranger_f \gset

select tests.authenticate_as(:'owner_f');
insert into communities (name, invite_code, owner_id) values ('Company F', 'FFFFFF', :'owner_f') returning id as company_f \gset
insert into sites (community_id, name, created_by_id) values (:'company_f', 'Site F', :'owner_f') returning id as site_f \gset

select tests.authenticate_as(:'worker_f');
insert into community_memberships (community_id, user_id, status) values (:'company_f', :'worker_f', 'pending');
select tests.authenticate_as(:'buyer_f');
insert into community_memberships (community_id, user_id, status) values (:'company_f', :'buyer_f', 'pending');
select tests.authenticate_as(:'driver_f');
insert into community_memberships (community_id, user_id, status) values (:'company_f', :'driver_f', 'pending');
select tests.authenticate_as(:'buyer2_f');
insert into community_memberships (community_id, user_id, status) values (:'company_f', :'buyer2_f', 'pending');

select tests.set_membership_status(:'company_f', :'worker_f', 'approved', :'owner_f');
select tests.set_membership_status(:'company_f', :'buyer_f', 'approved', :'owner_f');
select tests.set_membership_status(:'company_f', :'driver_f', 'approved', :'owner_f');
select tests.set_membership_status(:'company_f', :'buyer2_f', 'approved', :'owner_f');
select tests.authenticate_as(:'owner_f');
insert into site_memberships (site_id, community_id, user_id, added_by_id) values (:'site_f', :'company_f', :'worker_f', :'owner_f');
insert into site_memberships (site_id, community_id, user_id, added_by_id) values (:'site_f', :'company_f', :'buyer_f', :'owner_f');
insert into buyer_grants (community_id, user_id, granted_by_id) values (:'company_f', :'buyer_f', :'owner_f');

-- ======================================================================
-- 1-2: buyer_access_granted
-- ======================================================================
insert into buyer_grants (community_id, user_id, granted_by_id) values (:'company_f', :'buyer2_f', :'owner_f');
select notify_buyer_access_granted(:'company_f', :'buyer2_f');
select tests.authenticate_as(:'buyer2_f');
select ok(
  exists(select 1 from notifications where recipient_user_id = :'buyer2_f' and type = 'buyer_access_granted' and community_id = :'company_f'),
  '1: buyer_access_granted — legitimate success creates the correct notification'
);
select tests.authenticate_as(:'stranger_f');
select throws_ok(
  format($$ select notify_buyer_access_granted(%L, %L) $$, :'company_f', :'buyer2_f'),
  '42501', null,
  '2: buyer_access_granted — a stranger cannot claim credit for a grant they did not make'
);

-- ======================================================================
-- 3-5: buyer_access_revoked, now via the authoritative revoke_buyer_access RPC
-- ======================================================================
select tests.authenticate_as(:'owner_f');
select revoke_buyer_access(:'company_f', :'buyer2_f');
select tests.authenticate_as(:'buyer2_f');
select is(
  (select count(*) from buyer_grants where community_id = :'company_f' and user_id = :'buyer2_f')::int, 0,
  '3a: buyer_access_revoked — the grant is actually gone after a legitimate revoke'
);
select ok(
  exists(select 1 from notifications where recipient_user_id = :'buyer2_f' and type = 'buyer_access_revoked' and community_id = :'company_f'),
  '3b: buyer_access_revoked — legitimate success creates the correct notification'
);

select tests.authenticate_as(:'owner_f');
select throws_ok(
  format($$ select revoke_buyer_access(%L, %L) $$, :'company_f', :'stranger_f'),
  '42704', null,
  '4a: buyer_access_revoked — revoking a grant that never existed is refused, not silently accepted'
);
select tests.authenticate_as(:'stranger_f');
select is(
  (select count(*) from notifications where recipient_user_id = :'stranger_f' and type = 'buyer_access_revoked')::int, 0,
  '4b: buyer_access_revoked — no misleading notification is created for the never-a-buyer recipient'
);

select tests.authenticate_as(:'worker_f');
select throws_ok(
  format($$ select revoke_buyer_access(%L, %L) $$, :'company_f', :'buyer_f'),
  '42501', null,
  '5a: buyer_access_revoked — a non-owner cannot revoke anyone''s buyer access'
);
select tests.authenticate_as(:'owner_f');
select is(
  (select count(*) from buyer_grants where community_id = :'company_f' and user_id = :'buyer_f')::int, 1,
  '5b: buyer_access_revoked — the real buyer''s grant is untouched by the refused unauthorized attempt'
);
select tests.authenticate_as(:'buyer_f');
select is(
  (select count(*) from notifications where recipient_user_id = :'buyer_f' and type = 'buyer_access_revoked')::int, 0,
  '5c: buyer_access_revoked — no notification reaches the real buyer from the refused unauthorized attempt'
);

-- ======================================================================
-- 6-7: buyer_access_requested
-- ======================================================================
select tests.authenticate_as(:'buyer2_f');
insert into buyer_requests (community_id, user_id, status) values (:'company_f', :'buyer2_f', 'pending') returning id as request_f \gset
select notify_buyer_access_requested(:'request_f');
select tests.authenticate_as(:'owner_f');
select ok(
  exists(select 1 from notifications where recipient_user_id = :'owner_f' and type = 'buyer_access_requested' and request_id = :'request_f'),
  '6: buyer_access_requested — legitimate success notifies the owner with the correct request_id'
);
select tests.authenticate_as(:'stranger_f');
select throws_ok(
  format($$ select notify_buyer_access_requested(%L) $$, :'request_f'),
  '42501', null,
  '7: buyer_access_requested — a stranger cannot claim someone else''s request as their own'
);

-- ======================================================================
-- 8-9: buyer_access_rejected
-- ======================================================================
select tests.authenticate_as(:'owner_f');
update buyer_requests set status = 'declined', decided_at = now(), decided_by_id = :'owner_f' where id = :'request_f';
select notify_buyer_access_rejected(:'request_f');
select tests.authenticate_as(:'buyer2_f');
select ok(
  exists(select 1 from notifications where recipient_user_id = :'buyer2_f' and type = 'buyer_access_rejected' and request_id = :'request_f'),
  '8: buyer_access_rejected — legitimate success notifies the requester'
);
select tests.authenticate_as(:'stranger_f');
select throws_ok(
  format($$ select notify_buyer_access_rejected(%L) $$, :'request_f'),
  '42501', null,
  '9: buyer_access_rejected — a stranger cannot claim they decided a request they did not decide'
);

-- ======================================================================
-- 10-11: site_member_added
-- ======================================================================
select tests.authenticate_as(:'owner_f');
insert into site_memberships (site_id, community_id, user_id, added_by_id) values (:'site_f', :'company_f', :'driver_f', :'owner_f');
select notify_site_member_added(:'site_f', :'driver_f');
select tests.authenticate_as(:'driver_f');
select ok(
  exists(select 1 from notifications where recipient_user_id = :'driver_f' and type = 'site_member_added' and site_id = :'site_f'),
  '10: site_member_added — legitimate success creates the correct notification'
);
select tests.authenticate_as(:'stranger_f');
select throws_ok(
  format($$ select notify_site_member_added(%L, %L) $$, :'site_f', :'driver_f'),
  '42501', null,
  '11: site_member_added — a stranger cannot claim credit for an assignment they did not make'
);

-- ======================================================================
-- 12-14: site_member_removed, now via the authoritative remove_site_member RPC
-- ======================================================================
select tests.authenticate_as(:'owner_f');
select remove_site_member(:'site_f', :'driver_f');
select tests.authenticate_as(:'driver_f');
select is(
  (select count(*) from site_memberships where site_id = :'site_f' and user_id = :'driver_f')::int, 0,
  '12a: site_member_removed — the membership is actually gone after a legitimate removal'
);
select ok(
  exists(select 1 from notifications where recipient_user_id = :'driver_f' and type = 'site_member_removed' and site_id = :'site_f'),
  '12b: site_member_removed — legitimate success creates the correct notification'
);

select tests.authenticate_as(:'owner_f');
select throws_ok(
  format($$ select remove_site_member(%L, %L) $$, :'site_f', :'stranger_f'),
  '42704', null,
  '13a: site_member_removed — removing a membership that never existed is refused, not silently accepted'
);
select tests.authenticate_as(:'stranger_f');
select is(
  (select count(*) from notifications where recipient_user_id = :'stranger_f' and type = 'site_member_removed')::int, 0,
  '13b: site_member_removed — no misleading notification is created for the never-a-member recipient'
);

-- re-add driver_f to prove the unauthorized-caller case below leaves a REAL
-- membership untouched, not just a hypothetical one
select tests.authenticate_as(:'owner_f');
insert into site_memberships (site_id, community_id, user_id, added_by_id) values (:'site_f', :'company_f', :'driver_f', :'owner_f');
select tests.authenticate_as(:'worker_f');
select throws_ok(
  format($$ select remove_site_member(%L, %L) $$, :'site_f', :'driver_f'),
  '42501', null,
  '14a: site_member_removed — a non-owner cannot remove anyone from the site'
);
select tests.authenticate_as(:'owner_f');
select is(
  (select count(*) from site_memberships where site_id = :'site_f' and user_id = :'driver_f')::int, 1,
  '14b: site_member_removed — the real member''s membership is untouched by the refused unauthorized attempt'
);
select tests.authenticate_as(:'driver_f');
select is(
  (select count(*) from notifications where recipient_user_id = :'driver_f' and type = 'site_member_removed')::int, 1,
  '14c: site_member_removed — no NEW notification reaches the real member from the refused unauthorized attempt (still just the one from 12b)'
);

-- ======================================================================
-- 15-16: site_archived
-- ======================================================================
select tests.authenticate_as(:'owner_f');
update sites set status = 'archived', archived_at = now(), archived_by_id = :'owner_f' where id = :'site_f';
select notify_site_archived(:'site_f');
select tests.authenticate_as(:'worker_f');
select ok(
  exists(select 1 from notifications where recipient_user_id = :'worker_f' and type = 'site_archived' and site_id = :'site_f'),
  '15: site_archived — legitimate success notifies current site members'
);
select tests.authenticate_as(:'stranger_f');
select throws_ok(
  format($$ select notify_site_archived(%L) $$, :'site_f'),
  '42501', null,
  '16: site_archived — a stranger cannot fabricate an archive notification for a site they never archived'
);

-- ======================================================================
-- bonus: the two superseded 0014 RPCs are now unreachable by ANY client,
-- including a genuine owner — this is what actually closes the gap, not
-- just the existence of the new RPCs alongside the old ones.
-- ======================================================================
select tests.authenticate_as(:'owner_f');
select throws_ok(
  format($$ select notify_buyer_access_revoked(%L, %L) $$, :'company_f', :'buyer_f'),
  '42501', null,
  '17: notify_buyer_access_revoked is no longer callable by anyone, even a real owner (EXECUTE revoked in 0015)'
);
select throws_ok(
  format($$ select notify_site_member_removed(%L, %L) $$, :'site_f', :'worker_f'),
  '42501', null,
  '18: notify_site_member_removed is no longer callable by anyone, even a real owner (EXECUTE revoked in 0015)'
);

-- ======================================================================
-- Order-lifecycle notification matrix — a real progression through six
-- orders, proving every one of the 12 server-generated order notification
-- types is created correctly at least once (not just code-reviewed).
-- site_f is archived above but that never blocks lifecycle actions on
-- orders already/being placed against it (archiving only removes it from
-- pickers for NEW orders) — re-activate it here purely so create_order's
-- own can_create_order_for_site check (which requires an active site)
-- keeps passing for this section's fixture orders.
-- ======================================================================
select tests.authenticate_as(:'owner_f');
update sites set status = 'active', archived_at = null, archived_by_id = null where id = :'site_f';

-- delivery_available/delivery_claimed/delivery_collected each default OFF
-- (their own sub-switch, distinct from the deliveryUpdates category default
-- of ON — see notification_type_enabled_for) — opt driver_f/buyer_f in
-- explicitly so this section can actually observe them being created,
-- exactly like 06's own preference-suppression test relies on defaults
-- deliberately doing the opposite.
select tests.authenticate_as(:'driver_f');
insert into notification_preferences (user_id, delivery_available_enabled, delivery_claimed_enabled, delivery_collected_enabled)
values (:'driver_f', true, true, true);
select tests.authenticate_as(:'buyer_f');
insert into notification_preferences (user_id, delivery_available_enabled, delivery_claimed_enabled, delivery_collected_enabled)
values (:'buyer_f', true, true, true);
select tests.authenticate_as(:'owner_f');

-- --- Order A: full happy path through delivered ---
select tests.authenticate_as(:'worker_f');
select create_order(:'company_f', :'site_f', 'p1', 'Cement', '25kg bag', 5, 'bag', 'SW1A 1AA', null, null, 'b1', 'Merchant', 'merchant.co.uk', 'SW1 1AA', 'today', 6.75, null, null) as order_a \gset
select (:'order_a'::orders).id as order_a_id \gset

select tests.authenticate_as(:'owner_f');
select ok(
  exists(select 1 from notifications where recipient_user_id = :'owner_f' and type = 'order_awaiting_approval' and order_id = :'order_a_id'),
  '19: order_awaiting_approval — created on order submission'
);
select approve_order(:'order_a_id');
select tests.authenticate_as(:'buyer_f');
select ok(
  exists(select 1 from notifications where recipient_user_id = :'buyer_f' and type = 'order_ready_for_purchase' and order_id = :'order_a_id'),
  '20: order_ready_for_purchase — created on approval'
);
select start_purchase(:'order_a_id');
select complete_purchase(:'order_a_id');
select tests.authenticate_as(:'driver_f');
select ok(
  exists(select 1 from notifications where recipient_user_id = :'driver_f' and type = 'delivery_available' and order_id = :'order_a_id'),
  '21: delivery_available — created on purchase completion, reaching approved members'
);
select claim_delivery(:'order_a_id');
select tests.authenticate_as(:'buyer_f');
select ok(
  exists(select 1 from notifications where recipient_user_id = :'buyer_f' and type = 'delivery_claimed' and order_id = :'order_a_id'),
  '22: delivery_claimed — created when a driver claims the order'
);
select tests.authenticate_as(:'driver_f');
select mark_collected(:'order_a_id');
select tests.authenticate_as(:'buyer_f');
select ok(
  exists(select 1 from notifications where recipient_user_id = :'buyer_f' and type = 'delivery_collected' and order_id = :'order_a_id'),
  '23: delivery_collected — created when the driver marks collected'
);
select tests.authenticate_as(:'driver_f');
select mark_delivered(:'order_a_id', now(), 'Site F front gate');
select tests.authenticate_as(:'buyer_f');
select ok(
  exists(select 1 from notifications where recipient_user_id = :'buyer_f' and type = 'order_delivered' and order_id = :'order_a_id'),
  '24a: order_delivered — created for the buyer'
);
select tests.authenticate_as(:'worker_f');
select ok(
  exists(select 1 from notifications where recipient_user_id = :'worker_f' and type = 'order_delivered' and order_id = :'order_a_id'),
  '24b: order_delivered — created for the original requester too'
);

-- --- Order B: rejected ---
select tests.authenticate_as(:'worker_f');
select create_order(:'company_f', :'site_f', 'p2', 'Timber', '2.4m', 3, 'length', 'SW1A 1AA', null, null, 'b1', 'Merchant', 'merchant.co.uk', 'SW1 1AA', 'today', 4.50, null, null) as order_b \gset
select (:'order_b'::orders).id as order_b_id \gset
select tests.authenticate_as(:'owner_f');
select reject_order(:'order_b_id', 'Not needed right now');
select tests.authenticate_as(:'worker_f');
select ok(
  exists(select 1 from notifications where recipient_user_id = :'worker_f' and type = 'order_rejected' and order_id = :'order_b_id'),
  '25: order_rejected — created for the requester on rejection'
);

-- --- Order C: approval reverted ---
select create_order(:'company_f', :'site_f', 'p3', 'Hi-vis vest', 'L', 2, 'each', 'SW1A 1AA', null, null, 'b1', 'Merchant', 'merchant.co.uk', 'SW1 1AA', 'today', 8.00, null, null) as order_c \gset
select (:'order_c'::orders).id as order_c_id \gset
select tests.authenticate_as(:'owner_f');
select approve_order(:'order_c_id');
select revert_approval(:'order_c_id');
select tests.authenticate_as(:'worker_f');
select ok(
  exists(select 1 from notifications where recipient_user_id = :'worker_f' and type = 'approval_reverted' and order_id = :'order_c_id'),
  '26: approval_reverted — created for the requester when the owner reverts a decision'
);

-- --- Order D: delivery cancelled by driver ---
select create_order(:'company_f', :'site_f', 'p4', 'Drill', 'standard', 1, 'each', 'SW1A 1AA', null, null, 'b1', 'Merchant', 'merchant.co.uk', 'SW1 1AA', 'today', 45.00, null, null) as order_d \gset
select (:'order_d'::orders).id as order_d_id \gset
select tests.authenticate_as(:'owner_f');
select approve_order(:'order_d_id');
select tests.authenticate_as(:'buyer_f');
select start_purchase(:'order_d_id');
select complete_purchase(:'order_d_id');
select tests.authenticate_as(:'driver_f');
select claim_delivery(:'order_d_id');
select cancel_delivery(:'order_d_id', 'Vehicle broke down');
select tests.authenticate_as(:'buyer_f');
select ok(
  exists(select 1 from notifications where recipient_user_id = :'buyer_f' and type = 'delivery_cancelled' and order_id = :'order_d_id'),
  '27a: delivery_cancelled — created for the buyer'
);
select tests.authenticate_as(:'owner_f');
select ok(
  exists(select 1 from notifications where recipient_user_id = :'owner_f' and type = 'delivery_cancelled' and order_id = :'order_d_id'),
  '27b: delivery_cancelled — created for the owner too'
);

-- --- Order E: cancellation request rejected ---
select tests.authenticate_as(:'worker_f');
select create_order(:'company_f', :'site_f', 'p5', 'Rebar', '6m', 4, 'length', 'SW1A 1AA', null, null, 'b1', 'Merchant', 'merchant.co.uk', 'SW1 1AA', 'today', 6.20, null, null) as order_e \gset
select (:'order_e'::orders).id as order_e_id \gset
select tests.authenticate_as(:'owner_f');
select approve_order(:'order_e_id');
select tests.authenticate_as(:'buyer_f');
select start_purchase(:'order_e_id');
select complete_purchase(:'order_e_id');
select tests.authenticate_as(:'worker_f');
select request_cancellation(:'order_e_id', 'Ordered by mistake');
select tests.authenticate_as(:'buyer_f');
select ok(
  exists(select 1 from notifications where recipient_user_id = :'buyer_f' and type = 'cancellation_requested' and order_id = :'order_e_id'),
  '28: cancellation_requested — created for the buyer'
);
select decide_cancellation_request(
  (select id from cancellation_requests where order_id = :'order_e_id'), 'rejected', 'Already collected by the merchant'
);
select tests.authenticate_as(:'worker_f');
select ok(
  exists(select 1 from notifications where recipient_user_id = :'worker_f' and type = 'cancellation_rejected' and order_id = :'order_e_id'),
  '29: cancellation_rejected — created for the requester on a real Buyer decision'
);

-- --- Order F: cancellation request approved ---
select tests.authenticate_as(:'worker_f');
select create_order(:'company_f', :'site_f', 'p6', 'Plasterboard', '2.4m', 6, 'sheet', 'SW1A 1AA', null, null, 'b1', 'Merchant', 'merchant.co.uk', 'SW1 1AA', 'today', 12.00, null, null) as order_f_result \gset
select (:'order_f_result'::orders).id as order_f_id \gset
select tests.authenticate_as(:'owner_f');
select approve_order(:'order_f_id');
select tests.authenticate_as(:'buyer_f');
select start_purchase(:'order_f_id');
select complete_purchase(:'order_f_id');
select tests.authenticate_as(:'worker_f');
select request_cancellation(:'order_f_id', 'Wrong quantity');
select tests.authenticate_as(:'buyer_f');
select decide_cancellation_request(
  (select id from cancellation_requests where order_id = :'order_f_id'), 'approved', 'Confirmed not yet collected'
);
select tests.authenticate_as(:'worker_f');
select ok(
  exists(select 1 from notifications where recipient_user_id = :'worker_f' and type = 'cancellation_approved' and order_id = :'order_f_id'),
  '30: cancellation_approved — created for the requester on approval'
);

-- ======================================================================
-- No unintended duplicates across this whole matrix: every (recipient,
-- type, order/site/request) combination above was created exactly once.
-- ======================================================================
select tests.authenticate_as(:'buyer_f');
select is(
  (select count(*) from notifications where recipient_user_id = :'buyer_f' and type = 'order_ready_for_purchase' and order_id = :'order_a_id')::int, 1,
  '31: no duplicate order_ready_for_purchase notification for order A'
);
select tests.authenticate_as(:'worker_f');
select is(
  (select count(*) from notifications where recipient_user_id = :'worker_f' and type = 'order_delivered' and order_id = :'order_a_id')::int, 1,
  '32: no duplicate order_delivered notification for order A'
);
select tests.authenticate_as(:'driver_f');
select is(
  (select count(*) from notifications where recipient_user_id = :'driver_f' and type = 'site_member_added')::int, 1,
  '33: no duplicate site_member_added notification across the re-add in item 14''s fixture setup'
);
select tests.authenticate_as(:'owner_f');
select is(
  (select count(*) from notifications where recipient_user_id = :'owner_f' and type = 'delivery_cancelled' and order_id = :'order_d_id')::int, 1,
  '34: no duplicate delivery_cancelled notification for order D'
);
select tests.authenticate_as(:'worker_f');
select is(
  (select count(*) from notifications where recipient_user_id = :'worker_f' and type = 'cancellation_rejected' and order_id = :'order_e_id')::int, 1,
  '35: no duplicate cancellation_rejected notification for order E'
);

select finish();
rollback;
