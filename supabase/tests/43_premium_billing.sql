-- Migration 0055: Premium billing (Stripe) - database half.
-- Exercises the tables/functions directly; the Edge Functions that call them
-- (signature verification, Stripe API calls) are covered by the Deno tests in
-- supabase/functions/_shared/ and a mock-Stripe end-to-end run.
begin;
select plan(34);

select tests.create_user('bl-owner@test.local',    'BL Owner')    as owner    \gset
select tests.create_user('bl-worker@test.local',   'BL Worker')   as worker   \gset
select tests.create_user('bl-stranger@test.local', 'BL Stranger') as stranger \gset

select tests.authenticate_as(:'owner');
insert into communities (name, invite_code, owner_id) values ('BL Co', 'BLCO01', :'owner') returning id as co \gset
select tests.authenticate_as(:'worker');
insert into community_memberships (community_id, user_id, status) values (:'co', :'worker', 'pending');
select tests.authenticate_as(:'owner');
select tests.set_membership_status(:'co', :'worker', 'approved', :'owner');

-- ============================================================ grants
select tests.authenticate_as(:'owner');
select throws_ok(
  format($$ select apply_billing_event('evt_x', 'customer.subscription.updated', 1, %L, 'cus_x', 'sub_x', 'active', null, false) $$, :'co'),
  '42501', null, 'item 1: an authenticated owner cannot run apply_billing_event (cannot self-grant Premium)');
select tests.clear_authentication();
select throws_ok(
  format($$ select apply_billing_event('evt_x', 'customer.subscription.updated', 1, %L, 'cus_x', 'sub_x', 'active', null, false) $$, :'co'),
  '42501', null, 'item 2: anon cannot run apply_billing_event');

select tests.authenticate_as(:'owner');
select throws_ok($$ select count(*) from billing_events $$, '42501', null,
  'item 3: billing_events is not readable by a signed-in user');
select throws_ok($$ select stripe_customer_id from company_billing $$, '42501', null,
  'item 4: the Stripe customer id column is not readable by a signed-in user');
select throws_ok($$ insert into company_billing (community_id) values (gen_random_uuid()) $$, '42501', null,
  'item 5: a signed-in user cannot write company_billing');

-- ============================================================ checkout context
select tests.authenticate_as(:'owner');
select is((billing_checkout_context(:'co') ->> 'premium')::boolean, false,
  'item 6: an owner gets the checkout context (currently Free)');
select is(billing_checkout_context(:'co') ->> 'status', 'none', 'item 7: and the billing status starts as none');
select tests.authenticate_as(:'worker');
select throws_ok(format($$ select billing_checkout_context(%L) $$, :'co'), '42501', null,
  'item 8: a plain worker cannot get the checkout context');
select tests.authenticate_as(:'stranger');
select throws_ok(format($$ select billing_checkout_context(%L) $$, :'co'), '42501', null,
  'item 9: a stranger cannot get the checkout context');
select tests.clear_authentication();
select throws_ok(format($$ select billing_checkout_context(%L) $$, :'co'), '42501', null,
  'item 10: anon cannot get the checkout context');

-- ============================================================ applying events
reset role;
set local role service_role;

select is(
  (select apply_billing_event('evt_1', 'checkout.session.completed', 1000, :'co', 'cus_1', 'sub_1', 'active', null, null)),
  'applied', 'item 11: a paid checkout is applied by the service role');
reset role;
select is((select premium from communities where id = :'co'), true, 'item 12: the company is now Premium');
select is((select stripe_customer_id from company_billing where community_id = :'co'), 'cus_1',
  'item 13: the Stripe customer is linked');

set local role service_role;
select is(
  (select apply_billing_event('evt_1', 'checkout.session.completed', 1000, :'co', 'cus_1', 'sub_1', 'active', null, null)),
  'duplicate', 'item 14: redelivering the same event is a no-op');
select is(
  (select apply_billing_event('evt_old', 'customer.subscription.updated', 900, :'co', 'cus_1', 'sub_1', 'canceled', null, null)),
  'ignored_stale', 'item 15: an older event arriving late is ignored');
reset role;
select is((select premium from communities where id = :'co'), true, 'item 16: ...and did not switch Premium off');

set local role service_role;
select is(
  (select apply_billing_event('evt_pd', 'customer.subscription.updated', 1100, null, 'cus_1', 'sub_1', 'past_due',
                              '2026-11-01 00:00:00+00', true)),
  'applied', 'item 17: a past_due update is applied, matched by subscription id alone');
reset role;
select is((select premium from communities where id = :'co'), true,
  'item 18: past_due keeps Premium (Stripe is still retrying the card)');
select is((select cancel_at_period_end from company_billing where community_id = :'co'), true,
  'item 19: cancel_at_period_end is stored');
select is((select current_period_end from company_billing where community_id = :'co'),
  '2026-11-01 00:00:00+00'::timestamptz, 'item 20: the period end is stored');

-- the owner can read their own plan state, but not another company's
select tests.authenticate_as(:'owner');
select is((select status from company_billing where community_id = :'co'), 'past_due',
  'item 21: an owner can read their own company''s plan status');
select tests.authenticate_as(:'stranger');
select is((select count(*) from company_billing), 0::bigint,
  'item 22: a stranger sees no billing rows');

-- a link-only event (no status) must not change the plan
reset role;
set local role service_role;
select is(
  (select apply_billing_event('evt_link', 'checkout.session.completed', 1150, :'co', 'cus_1', 'sub_1', null, null, null)),
  'applied', 'item 23: a link-only event is applied');
reset role;
select is((select status from company_billing where community_id = :'co'), 'past_due',
  'item 24: ...without changing the recorded status');
select is((select premium from communities where id = :'co'), true, 'item 25: ...or the plan');

-- cancelling switches Premium off, and a company with a live sub can't be deleted
select is((select count(*) from company_billing where community_id = :'co' and status in ('active','past_due')), 1::bigint,
  'item 26: precondition - the subscription is still live');
select throws_ok(format($$ delete from communities where id = %L $$, :'co'), '55006', null,
  'item 27: a company with a live subscription cannot be deleted');

set local role service_role;
select is(
  (select apply_billing_event('evt_del', 'customer.subscription.deleted', 1200, null, 'cus_1', 'sub_1', 'canceled', null, false)),
  'applied', 'item 28: the cancellation is applied');
reset role;
select is((select premium from communities where id = :'co'), false, 'item 29: Premium is switched off on cancellation');

-- re-subscribing switches it back on
set local role service_role;
select apply_billing_event('evt_resub', 'customer.subscription.updated', 1300, null, 'cus_1', 'sub_1', 'active', null, false);
reset role;
select is((select premium from communities where id = :'co'), true, 'item 30: a later active event restores Premium');

-- unmatched + bad input
set local role service_role;
select is(
  (select apply_billing_event('evt_ghost', 'customer.subscription.updated', 1400, gen_random_uuid(), 'cus_zzz', 'sub_zzz', 'active', null, false)),
  'ignored_unmatched', 'item 31: an event for an unknown company is recorded and ignored');
select throws_ok(
  format($$ select apply_billing_event('evt_bad', 'customer.subscription.updated', 1500, %L, 'cus_1', 'sub_1', 'bogus', null, false) $$, :'co'),
  '22023', null, 'item 32: an unknown subscription status is refused');
reset role;
select is((select count(*) from billing_events where stripe_event_id = 'evt_bad'), 0::bigint,
  'item 33: ...and the refused event was not recorded (Stripe will retry)');

-- cancelled subscription no longer blocks deletion
set local role service_role;
select apply_billing_event('evt_end', 'customer.subscription.deleted', 1600, null, 'cus_1', 'sub_1', 'canceled', null, false);
reset role;
select lives_ok(format($$ delete from communities where id = %L $$, :'co'),
  'item 34: once the subscription is cancelled the company can be deleted');

select finish();
rollback;
