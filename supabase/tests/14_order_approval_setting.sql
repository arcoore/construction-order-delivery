-- Permanent regression coverage for the "require owner approval" setting's
-- effect on create_order, codifying a QA pass that was run manually first
-- (disposable users/community via tests.create_user/tests.authenticate_as,
-- same mechanism this file uses, rolled back afterward — nothing from that
-- pass persisted). Two things had genuinely zero prior test coverage
-- despite being exercised implicitly by other files: (1) that the setting
-- is captured PER ORDER at creation time and never retroactively reinterprets
-- an existing order after the community-level setting later changes, and
-- (2) that an order created with approval off produces exactly the
-- order_ready_for_purchase notification and none of the approval-path
-- notification/event/field shape — not just "the status ends up right."
begin;
select plan(29);

select tests.create_user('owner-g@test.local', 'Owner G')  as owner_g \gset
select tests.create_user('worker-g@test.local', 'Worker G') as worker_g \gset
select tests.create_user('buyer-g@test.local', 'Buyer G')  as buyer_g \gset

select tests.authenticate_as(:'owner_g');
insert into communities (name, invite_code, owner_id) values ('Company G', 'GGGGGG', :'owner_g') returning id as company_g \gset
insert into sites (community_id, name, created_by_id) values (:'company_g', 'Site G', :'owner_g') returning id as site_g \gset

-- community_memberships only allows a user to insert their OWN pending row
-- (community_memberships_insert_self_pending). Approval itself now goes
-- through decide_join_request (migration 0022) in real usage — its own
-- behavior is covered by 15_join_request_decision.sql; this fixture uses
-- the plain tests.set_membership_status bypass helper instead, since this
-- file is testing the approval-setting/order-creation interaction, not the
-- join-decision RPC itself.
select tests.authenticate_as(:'worker_g');
insert into community_memberships (community_id, user_id, status) values (:'company_g', :'worker_g', 'pending');
select tests.authenticate_as(:'buyer_g');
insert into community_memberships (community_id, user_id, status) values (:'company_g', :'buyer_g', 'pending');

select tests.set_membership_status(:'company_g', :'worker_g', 'approved', :'owner_g');
select tests.set_membership_status(:'company_g', :'buyer_g', 'approved', :'owner_g');
select tests.authenticate_as(:'owner_g');
insert into site_memberships (site_id, community_id, user_id, added_by_id) values (:'site_g', :'company_g', :'worker_g', :'owner_g');
insert into buyer_grants (community_id, user_id, granted_by_id) values (:'company_g', :'buyer_g', :'owner_g');
insert into site_memberships (site_id, community_id, user_id, added_by_id) values (:'site_g', :'company_g', :'buyer_g', :'owner_g');

-- require_owner_approval is left at its real DB default (true) here on
-- purpose, exactly like a genuinely new community — never set explicitly,
-- so this also incidentally re-confirms the default itself.

-- ================================================================
-- ORDER A — created while approval is ON
-- ================================================================
select tests.authenticate_as(:'worker_g');
select create_order(
  :'company_g', :'site_g', 'p1', 'Cement', '25kg bag', 5, 'bag', 'SW1A 1AA', null, null,
  'b1', 'Merchant', 'merchant.co.uk', 'SW1 1AA', 'today', 6.75, null, null
) as order_a_result \gset
select (:'order_a_result'::orders).id as order_a_id \gset

select is(
  (select status from orders where id = :'order_a_id')::text, 'pending_approval',
  'item 1: order A (approval ON) is created as pending_approval'
);
select is(
  (select approval_was_required from orders where id = :'order_a_id'), true,
  'item 2: order A snapshots approval_was_required = true'
);
select ok(
  (select requested_by_id = :'worker_g' and community_id = :'company_g' and site_id = :'site_g'
   from orders where id = :'order_a_id'),
  'item 3: order A has the correct requester/community/site identity'
);
select ok(
  (select approved_by_id is null and approved_at is null and rejected_by_id is null and rejected_at is null
   from orders where id = :'order_a_id'),
  'item 4: order A has no approval/rejection fields set (nothing has decided it yet)'
);

select tests.authenticate_as(:'owner_g');
select is(
  (select count(*) from notifications where recipient_user_id = :'owner_g' and type = 'order_awaiting_approval' and order_id = :'order_a_id')::int, 1,
  'item 5: exactly one order_awaiting_approval notification was sent to the Owner for order A'
);
select tests.authenticate_as(:'buyer_g');
select is(
  (select count(*) from notifications where recipient_user_id = :'buyer_g' and type = 'order_ready_for_purchase' and order_id = :'order_a_id')::int, 0,
  'item 6: no order_ready_for_purchase notification exists for order A (approval was required)'
);

-- ================================================================
-- TOGGLE approval OFF — order A must NOT be retroactively reinterpreted
-- ================================================================
select tests.authenticate_as(:'owner_g');
update communities set require_owner_approval = false where id = :'company_g';
select is(
  (select require_owner_approval from communities where id = :'company_g'), false,
  'item 7: require_owner_approval is now false for the community'
);
select is(
  (select status from orders where id = :'order_a_id')::text, 'pending_approval',
  'item 8: order A (created before the toggle) is still pending_approval after approval is turned off'
);
select is(
  (select approval_was_required from orders where id = :'order_a_id'), true,
  'item 9: order A still snapshots approval_was_required = true — the setting is per-order, not retroactive'
);

-- ================================================================
-- ORDER B — created after approval is OFF (the case under test)
-- ================================================================
select tests.authenticate_as(:'worker_g');
select create_order(
  :'company_g', :'site_g', 'p1', 'Cement', '25kg bag', 3, 'bag', 'SW1A 1AA', null, null,
  'b1', 'Merchant', 'merchant.co.uk', 'SW1 1AA', 'today', 6.75, null, null
) as order_b_result \gset
select (:'order_b_result'::orders).id as order_b_id \gset

select is(
  (select status from orders where id = :'order_b_id')::text, 'pending_purchase',
  'item 10: order B (approval OFF) skips straight to pending_purchase'
);
select is(
  (select approval_was_required from orders where id = :'order_b_id'), false,
  'item 11: order B snapshots approval_was_required = false'
);
select ok(
  (select requested_by_id = :'worker_g' and community_id = :'company_g' and site_id = :'site_g'
   from orders where id = :'order_b_id'),
  'item 12: order B has the correct requester/community/site identity'
);
select ok(
  (select approved_by_id is null and approved_at is null and rejected_by_id is null and rejected_at is null
   from orders where id = :'order_b_id'),
  'item 13: order B has no approval/rejection fields set — no approval workflow ever touched it'
);

select tests.authenticate_as(:'buyer_g');
select is(
  (select count(*) from notifications where recipient_user_id = :'buyer_g' and type = 'order_ready_for_purchase' and order_id = :'order_b_id')::int, 1,
  'item 14: exactly one order_ready_for_purchase notification was sent to the Buyer for order B'
);
select tests.authenticate_as(:'owner_g');
select is(
  (select count(*) from notifications where recipient_user_id = :'owner_g' and type = 'order_awaiting_approval' and order_id = :'order_b_id')::int, 0,
  'item 15: no order_awaiting_approval notification exists for order B (approval was off)'
);

-- ================================================================
-- PERMISSION CHECKS on order B
-- ================================================================
select tests.authenticate_as(:'owner_g');
select throws_ok(
  format($$ select approve_order(%L) $$, :'order_b_id'),
  '40001', null,
  'item 16: the Owner cannot approve order B — it was never awaiting approval'
);

select tests.authenticate_as(:'worker_g');
select throws_ok(
  format($$ select start_purchase(%L) $$, :'order_b_id'),
  '42501', null,
  'item 17: the Worker (not a buyer) cannot start_purchase on order B'
);

select tests.authenticate_as(:'buyer_g');
select is(
  (select status from start_purchase(:'order_b_id'))::text, 'purchase_in_progress',
  'item 18: the Buyer successfully starts purchasing order B with no approval precondition'
);
select is(
  (select status from abandon_purchase(:'order_b_id'))::text, 'pending_purchase',
  'item 19: the Buyer can abandon back to pending_purchase'
);

-- ================================================================
-- EVENT / HISTORY CHECKS on order B
-- ================================================================
select tests.authenticate_as(:'owner_g');
select ok(
  exists(select 1 from order_events where order_id = :'order_b_id' and type = 'order_created' and to_status = 'pending_purchase'),
  'item 20: order B has an order_created event landing directly on pending_purchase'
);
select ok(
  exists(select 1 from order_events where order_id = :'order_b_id' and type = 'purchase_started' and from_status = 'pending_purchase' and to_status = 'purchase_in_progress'),
  'item 21: order B has a purchase_started event after the Buyer started it'
);
select ok(
  exists(select 1 from order_events where order_id = :'order_b_id' and type = 'purchase_abandoned' and from_status = 'purchase_in_progress' and to_status = 'pending_purchase'),
  'item 22: order B has a purchase_abandoned event after the Buyer abandoned it'
);
select ok(
  not exists(select 1 from order_events where order_id = :'order_b_id' and type = 'approved'),
  'item 23: order B has no approved event anywhere in its history'
);

-- ================================================================
-- FINAL PERSISTENCE / NO-DUPLICATION CHECKS
-- ================================================================
select ok(
  (select status = 'pending_approval' and approval_was_required = true from orders where id = :'order_a_id'),
  'item 24: order A ends the test still pending_approval / approval_was_required = true'
);
select ok(
  (select status = 'pending_purchase' and approval_was_required = false from orders where id = :'order_b_id'),
  'item 25: order B ends the test pending_purchase / approval_was_required = false'
);
select is(
  (select count(*) from orders where community_id = :'company_g')::int, 2,
  'item 26: exactly two orders exist for this community — no duplicate orders from the two create_order calls'
);
-- checked per-recipient (not combined into one query) because notifications
-- RLS scopes SELECT to recipient_user_id = auth.uid() — a single session can
-- only ever see its own notifications, exactly like items 5/6/14/15 above.
select tests.authenticate_as(:'owner_g');
select is(
  (select count(*) from notifications where recipient_user_id = :'owner_g' and type = 'order_awaiting_approval')::int, 1,
  'item 27: no duplicate order_awaiting_approval notifications exist for the Owner across the whole test'
);
select tests.authenticate_as(:'buyer_g');
select is(
  (select count(*) from notifications where recipient_user_id = :'buyer_g' and type = 'order_ready_for_purchase')::int, 1,
  'item 28: no duplicate order_ready_for_purchase notifications exist for the Buyer across the whole test'
);
select tests.authenticate_as(:'owner_g');
select is(
  (select count(*) from order_events where community_id = :'company_g')::int, 4,
  'item 29: exactly four order_events exist total (2x order_created, 1x purchase_started, 1x purchase_abandoned) — no duplicate events'
);

select finish();
rollback;
