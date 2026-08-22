-- Roadmap Step 2 — structured "Needed by" deadlines (migration 0019).
-- Covers: the orders_needed_by_valid_state CHECK constraint directly,
-- signature/grant integrity for the widened create_order/edit_order (the
-- exact same defense-in-depth class of check 05_rpc_auth_hardening.sql
-- already established for every lifecycle RPC), real create_order/edit_order
-- behavior (ASAP round-trips to a NULL timestamp, a genuine future deadline
-- is accepted, a past deadline is refused on create AND on a real change at
-- edit time, but an unrelated edit is never blocked merely because an
-- order's EXISTING deadline has since naturally passed), the needed-by-only
-- edit diff, and that a historical (pre-migration-shaped) NULL/NULL order
-- remains readable.
begin;
select plan(22);

select tests.create_user('owner-g@test.local', 'Owner G')       as owner_g \gset
select tests.create_user('worker-g@test.local', 'Worker G')     as worker_g \gset

insert into communities (name, invite_code, owner_id) values ('Company G', 'GGGGGG', :'owner_g') returning id as company_g \gset
insert into sites (community_id, name, created_by_id) values (:'company_g', 'Site G', :'owner_g') returning id as site_g \gset
insert into community_memberships (community_id, user_id, status, decided_by_id) values (:'company_g', :'worker_g', 'approved', :'owner_g');
insert into site_memberships (site_id, community_id, user_id, added_by_id) values (:'site_g', :'company_g', :'worker_g', :'owner_g');

-- ================================================================
-- Part A (items 1-7) — orders_needed_by_valid_state CHECK constraint,
-- exercised via direct privileged inserts (still the ambient role, before
-- any tests.authenticate_as call — matching 09/10's established convention
-- for pure constraint tests, since role transitions in this suite only
-- ever move downward). A minimal otherwise-valid order row, varying only
-- needed_by_type/needed_by.
-- ================================================================

select lives_ok(
  format($$ insert into orders (community_id, site_id, site_name, product_id, product_name, quantity, unit, delivery_postcode, requested_by_id, requested_by, needed_by_type, needed_by) values (%L, %L, 'Site G', 'p1', 'Test Product', 1, 'each', 'SW1A 1AA', %L, 'Worker G', null, null) $$,
    :'company_g', :'site_g', :'worker_g'),
  'item 1: historical NULL/NULL (needed_by_type null, needed_by null) is a valid state'
);
select id as historical_order_id from orders where product_id = 'p1' and community_id = :'company_g' \gset

select lives_ok(
  format($$ insert into orders (community_id, site_id, site_name, product_id, product_name, quantity, unit, delivery_postcode, requested_by_id, requested_by, needed_by_type, needed_by) values (%L, %L, 'Site G', 'p1', 'Test Product', 1, 'each', 'SW1A 1AA', %L, 'Worker G', 'asap', null) $$,
    :'company_g', :'site_g', :'worker_g'),
  'item 2: asap + NULL timestamp is a valid state'
);

select lives_ok(
  format($$ insert into orders (community_id, site_id, site_name, product_id, product_name, quantity, unit, delivery_postcode, requested_by_id, requested_by, needed_by_type, needed_by) values (%L, %L, 'Site G', 'p1', 'Test Product', 1, 'each', 'SW1A 1AA', %L, 'Worker G', 'deadline', now() + interval '1 day') $$,
    :'company_g', :'site_g', :'worker_g'),
  'item 3: deadline + a real future timestamp is a valid state'
);

select throws_ok(
  format($$ insert into orders (community_id, site_id, site_name, product_id, product_name, quantity, unit, delivery_postcode, requested_by_id, requested_by, needed_by_type, needed_by) values (%L, %L, 'Site G', 'p1', 'Test Product', 1, 'each', 'SW1A 1AA', %L, 'Worker G', 'asap', now() + interval '1 day') $$,
    :'company_g', :'site_g', :'worker_g'),
  '23514', null,
  'item 4: asap + a non-NULL timestamp is rejected by the CHECK constraint'
);

select throws_ok(
  format($$ insert into orders (community_id, site_id, site_name, product_id, product_name, quantity, unit, delivery_postcode, requested_by_id, requested_by, needed_by_type, needed_by) values (%L, %L, 'Site G', 'p1', 'Test Product', 1, 'each', 'SW1A 1AA', %L, 'Worker G', 'deadline', null) $$,
    :'company_g', :'site_g', :'worker_g'),
  '23514', null,
  'item 5: deadline + NULL timestamp is rejected by the CHECK constraint'
);

select throws_ok(
  format($$ insert into orders (community_id, site_id, site_name, product_id, product_name, quantity, unit, delivery_postcode, requested_by_id, requested_by, needed_by_type, needed_by) values (%L, %L, 'Site G', 'p1', 'Test Product', 1, 'each', 'SW1A 1AA', %L, 'Worker G', 'today', now() + interval '1 day') $$,
    :'company_g', :'site_g', :'worker_g'),
  '23514', null,
  'item 6: an invalid needed_by_type value (''today''/''tomorrow''/''custom'' are UI shortcuts only, never stored types) is rejected'
);

select throws_ok(
  format($$ insert into orders (community_id, site_id, site_name, product_id, product_name, quantity, unit, delivery_postcode, requested_by_id, requested_by, needed_by_type, needed_by) values (%L, %L, 'Site G', 'p1', 'Test Product', 1, 'each', 'SW1A 1AA', %L, 'Worker G', null, now() + interval '1 day') $$,
    :'company_g', :'site_g', :'worker_g'),
  '23514', null,
  'item 7: NULL needed_by_type + a non-NULL timestamp is rejected by the CHECK constraint'
);

-- Fixture for item 21 below: an order whose deadline is ALREADY in the
-- past, simulating real time having moved past a deadline that was
-- perfectly legitimate when it was originally set. Only createable via a
-- direct privileged insert — create_order itself would rightly refuse a
-- past deadline (item 15 below), so there is no legitimate way to produce
-- this row through the real RPC. The CHECK constraint only enforces
-- co-presence, never "in the future", so this insert is valid on its own
-- terms.
insert into orders (community_id, site_id, site_name, product_id, product_name, quantity, unit, delivery_postcode, requested_by_id, requested_by, status, approval_was_required, needed_by_type, needed_by)
values (:'company_g', :'site_g', 'Site G', 'p5', 'Past Deadline Fixture', 1, 'each', 'SW1A 1AA', :'worker_g', 'Worker G', 'pending_approval', true, 'deadline', now() - interval '1 day')
returning id as past_deadline_order_id, version as past_deadline_order_version, needed_by as past_deadline_value \gset

-- ================================================================
-- Part B (items 8-13) — signature/grant integrity for the widened RPCs,
-- the same defense-in-depth class of check 05_rpc_auth_hardening.sql
-- already established for every other lifecycle RPC.
-- has_function_privilege/to_regprocedure are pure catalog introspection
-- and don't depend on the current session role, so this runs fine from the
-- still-ambient role.
-- ================================================================

select ok(
  to_regprocedure('public.create_order(uuid, uuid, text, text, text, numeric, text, text, double precision, double precision, text, text, text, text, text, numeric)') is null
  and to_regprocedure('public.edit_order(uuid, integer, text, text, text, numeric, text, text, double precision, double precision, uuid, text, text, text, text, text, numeric)') is null,
  'item 8: the obsolete 16-arg create_order and 17-arg edit_order signatures no longer exist'
);
select ok(
  to_regprocedure('public.create_order(uuid, uuid, text, text, text, numeric, text, text, double precision, double precision, text, text, text, text, text, numeric, text, timestamptz)') is not null
  and to_regprocedure('public.edit_order(uuid, integer, text, text, text, numeric, text, text, double precision, double precision, uuid, text, text, text, text, text, numeric, text, timestamptz)') is not null,
  'item 9: the new 18-arg create_order and 19-arg edit_order signatures resolve to real functions (catches drift/typos in this file itself)'
);

select ok(
  has_function_privilege('authenticated',
    'create_order(uuid, uuid, text, text, text, numeric, text, text, double precision, double precision, text, text, text, text, text, numeric, text, timestamptz)', 'EXECUTE'),
  'item 10: authenticated can execute the new create_order signature'
);
select ok(
  has_function_privilege('authenticated',
    'edit_order(uuid, integer, text, text, text, numeric, text, text, double precision, double precision, uuid, text, text, text, text, text, numeric, text, timestamptz)', 'EXECUTE'),
  'item 11: authenticated can execute the new edit_order signature'
);

select ok(
  not has_function_privilege('anon',
    'create_order(uuid, uuid, text, text, text, numeric, text, text, double precision, double precision, text, text, text, text, text, numeric, text, timestamptz)', 'EXECUTE')
  and not has_function_privilege('anon',
    'edit_order(uuid, integer, text, text, text, numeric, text, text, double precision, double precision, uuid, text, text, text, text, text, numeric, text, timestamptz)', 'EXECUTE'),
  'item 12: anon cannot execute either new signature'
);
select ok(
  not has_function_privilege('public',
    'create_order(uuid, uuid, text, text, text, numeric, text, text, double precision, double precision, text, text, text, text, text, numeric, text, timestamptz)', 'EXECUTE')
  and not has_function_privilege('public',
    'edit_order(uuid, integer, text, text, text, numeric, text, text, double precision, double precision, uuid, text, text, text, text, text, numeric, text, timestamptz)', 'EXECUTE'),
  'item 13: neither new signature retains a bare PUBLIC execute grant (the root cause 0013 originally closed for every other lifecycle RPC)'
);

-- ================================================================
-- Part C (items 14-26) — real create_order/edit_order behavior, as the
-- real requester.
-- ================================================================
select tests.authenticate_as(:'worker_g');

select create_order(:'company_g', :'site_g', 'p2', 'Cement', '25kg bag', 5, 'bag', 'SW1A 1AA', null, null, 'b1', 'Merchant', 'merchant.co.uk', 'SW1 1AA', 'today', 6.75, 'asap', null) as asap_result \gset
select ok(
  (:'asap_result'::orders).needed_by_type = 'asap' and (:'asap_result'::orders).needed_by is null,
  'item 14: create_order accepts ASAP and stores needed_by = NULL (never now())'
);

select create_order(:'company_g', :'site_g', 'p3', 'Sand', '25kg bag', 2, 'bag', 'SW1A 1AA', null, null, 'b1', 'Merchant', 'merchant.co.uk', 'SW1 1AA', 'today', 4.50, 'deadline', now() + interval '2 days') as deadline_result \gset
select ok(
  (:'deadline_result'::orders).needed_by_type = 'deadline' and (:'deadline_result'::orders).needed_by is not null,
  'item 15: create_order accepts and stores a genuine future deadline'
);
select (:'deadline_result'::orders).id as deadline_order_id \gset
select (:'deadline_result'::orders).version as deadline_order_version \gset

select throws_ok(
  format($$ select create_order(%L, %L, 'p4', 'Timber', '2.4m', 1, 'length', 'SW1A 1AA', null, null, 'b1', 'Merchant', 'merchant.co.uk', 'SW1 1AA', 'today', 12.00, 'deadline', now() - interval '1 hour') $$,
    :'company_g', :'site_g'),
  '22023', null,
  'item 16: create_order rejects a needed_by timestamp already in the past'
);

select edit_order(:'deadline_order_id', :'deadline_order_version', 'p3', 'Sand', '25kg bag', 2, 'bag', 'SW1A 1AA', null, null, :'site_g', 'b1', 'Merchant', 'merchant.co.uk', 'SW1 1AA', 'today', 4.50, 'asap', null) as edit_to_asap_result \gset
select ok(
  (:'edit_to_asap_result'::orders).needed_by_type = 'asap' and (:'edit_to_asap_result'::orders).needed_by is null,
  'item 17: edit_order can change an order''s deadline to ASAP, clearing the timestamp to NULL'
);

-- Everything else in this edit is identical to the order's current stored
-- state — only needed_by_type/needed_by actually change, so meta.changes
-- should contain exactly one key and nothing else.
select ok(
  exists(
    select 1 from order_events
    where order_id = :'deadline_order_id' and type = 'order_edited'
      and meta->'changes' ? 'neededByType'
      and meta->'changes'->'neededByType'->>'from' = 'deadline'
      and meta->'changes'->'neededByType'->>'to' = 'asap'
      and not (meta->'changes' ? 'quantity')
  ),
  'item 18: the needed-by-only edit above produced a correctly-shaped, needed-by-only entry in order_events.meta.changes'
);

select (:'edit_to_asap_result'::orders).version as after_asap_edit_version \gset
select edit_order(:'deadline_order_id', :'after_asap_edit_version', 'p3', 'Sand', '25kg bag', 2, 'bag', 'SW1A 1AA', null, null, :'site_g', 'b1', 'Merchant', 'merchant.co.uk', 'SW1 1AA', 'today', 4.50, 'deadline', now() + interval '3 days') as edit_to_deadline_result \gset
select ok(
  (:'edit_to_deadline_result'::orders).needed_by_type = 'deadline' and (:'edit_to_deadline_result'::orders).needed_by is not null,
  'item 19: edit_order can change an order''s deadline to a genuine new future timestamp'
);
select (:'edit_to_deadline_result'::orders).version as after_deadline_edit_version \gset

select throws_ok(
  format($$ select edit_order(%L, %L, 'p3', 'Sand', '25kg bag', 2, 'bag', 'SW1A 1AA', null, null, %L, 'b1', 'Merchant', 'merchant.co.uk', 'SW1 1AA', 'today', 4.50, 'deadline', now() - interval '1 hour') $$,
    :'deadline_order_id', :'after_deadline_edit_version', :'site_g'),
  '22023', null,
  'item 20: edit_order rejects changing needed_by to a timestamp already in the past'
);

-- An unrelated permitted edit (quantity only) remains possible even though
-- this order's EXISTING deadline has since naturally passed — the same
-- past_deadline_value is passed straight back unchanged, so the
-- past-deadline guard never runs for it at all (it only re-validates when
-- the deadline is actually changing).
select edit_order(:'past_deadline_order_id', :'past_deadline_order_version', 'p5', 'Past Deadline Fixture', null, 2, 'each', 'SW1A 1AA', null, null, :'site_g', null, null, null, null, null, null, 'deadline', :'past_deadline_value') as unrelated_edit_result \gset
select ok(
  (:'unrelated_edit_result'::orders).quantity = 2::numeric
  and (:'unrelated_edit_result'::orders).needed_by_type = 'deadline'
  and (:'unrelated_edit_result'::orders).needed_by = :'past_deadline_value'::timestamptz,
  'item 21: an unrelated edit succeeds and takes effect even though this order''s existing deadline has already passed, leaving the untouched past deadline exactly as it was'
);

-- A historical NULL/NULL order (item 1's fixture) remains readable through
-- the same RLS path a real client uses, as an approved member of its
-- community — never fabricated into a fake ASAP/deadline value.
select ok(
  exists(select 1 from orders where id = :'historical_order_id' and needed_by_type is null and needed_by is null),
  'item 22: a historical NULL/NULL order remains readable and its needed_by fields stay honestly null, never fabricated'
);

select finish();
rollback;
