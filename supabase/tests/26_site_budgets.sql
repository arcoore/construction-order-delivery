-- Site monthly budgets, hard block (migration 0033). The orders_enforce_site_budget
-- trigger refuses an INSERT/total-change that would push the site's
-- current-month committed spend over monthly_budget; a plain status
-- transition on an already-accepted order is exempt; a null budget is
-- unlimited.
begin;
select plan(12);

select tests.create_user('owner-bg@test.local', 'Owner BG')   as owner_bg \gset
select tests.create_user('worker-bg@test.local', 'Worker BG') as worker_bg \gset

insert into communities (name, invite_code, owner_id, require_owner_approval)
  values ('BG Co', 'BGCO01', :'owner_bg', false) returning id as co \gset
insert into sites (community_id, name, created_by_id, monthly_budget)
  values (:'co', 'Capped Site', :'owner_bg', 100) returning id as capped \gset
insert into sites (community_id, name, created_by_id)
  values (:'co', 'Uncapped Site', :'owner_bg') returning id as uncapped \gset

insert into community_memberships (community_id, user_id, status, decided_by_id)
  values (:'co', :'worker_bg', 'approved', :'owner_bg');
insert into site_memberships (site_id, community_id, user_id, added_by_id) values
  (:'capped', :'co', :'worker_bg', :'owner_bg'),
  (:'uncapped', :'co', :'worker_bg', :'owner_bg');

select tests.authenticate_as(:'worker_bg');

-- item 1: first order within budget
select tests.create_order_1(:'co', :'capped', 'p1', 'Cement', '25kg', 6, 'bag', 'SW1A 1AA', null, null, 'b1', 'M', 'm.co.uk', 'SW1 1AA', 'today', 10.00, null, null) as o1 \gset
select ok((:'o1'::orders).total_price = 60.00, 'item 1: a £60 order under the £100 cap is created');

-- item 2: second order would take committed to £120 — blocked
select throws_ok(
  format($$ select tests.create_order_1(%L, %L, 'p1', 'Cement', '25kg', 6, 'bag', 'SW1A 1AA', null, null, 'b1', 'M', 'm.co.uk', 'SW1 1AA', 'today', 10.00, null, null) $$, :'co', :'capped'),
  '22023', null,
  'item 2: a second £60 order (would be £120 committed) is refused by the budget trigger'
);

-- item 3: a £40 order exactly fills the cap (60 + 40 = 100, not over)
select tests.create_order_1(:'co', :'capped', 'p2', 'Sand', 'bulk', 4, 'bag', 'SW1A 1AA', null, null, 'b1', 'M', 'm.co.uk', 'SW1 1AA', 'today', 10.00, null, null) as o3 \gset
select ok((:'o3'::orders).total_price = 40.00, 'item 3: a £40 order exactly reaching the £100 cap is allowed');

-- item 4: even £0.01 more is refused
select throws_ok(
  format($$ select tests.create_order_1(%L, %L, 'p3', 'Nails', '50mm', 1, 'box', 'SW1A 1AA', null, null, 'b1', 'M', 'm.co.uk', 'SW1 1AA', 'today', 0.01, null, null) $$, :'co', :'capped'),
  '22023', null,
  'item 4: an order that would exceed the cap by a penny is refused'
);

-- item 5: cancelling one order frees budget
select (:'o1'::orders).id as o1_id \gset
select cancel_order_direct(:'o1_id', 'no longer needed');
select is((select status from orders where id = :'o1_id'), 'cancelled', 'item 5: the £60 order is cancelled');

-- item 6: now a £50 order fits (committed is £40 after the cancel)
select tests.create_order_1(:'co', :'capped', 'p4', 'Timber', '2.4m', 5, 'length', 'SW1A 1AA', null, null, 'b1', 'M', 'm.co.uk', 'SW1 1AA', 'today', 10.00, null, null) as o6 \gset
select ok((:'o6'::orders).total_price = 50.00, 'item 6: after a cancellation frees budget, a £50 order is allowed (£90 committed)');

-- item 7: editing that order up to £70 total would exceed (90 - 50 + 70 = 110) — refused
select (:'o6'::orders).id as o6_id \gset
select (:'o6'::orders).version as o6_v \gset
select throws_ok(
  format($$ select edit_order(%L, %L, jsonb_build_array(jsonb_build_object('productId','p4','productName','Timber','variant','2.4m','quantity',7,'unit','length','unitPrice',10.00)), 'SW1A 1AA', null, null, %L, 'b1', 'M', 'm.co.uk', 'SW1 1AA', 'today', null, null) $$,
    :'o6_id', :'o6_v', :'capped'),
  '22023', null,
  'item 7: an edit that would push the site over budget is refused'
);

-- item 8: a status transition on an already-accepted at/over-budget order is
-- exempt (the owner drives start_purchase here via the can_purchase_for_site
-- owner bypass; the point is the trigger, not who calls it).
select (:'o3'::orders).id as o3_id \gset
select tests.authenticate_as(:'owner_bg');
update sites set monthly_budget = 10 where id = :'capped';  -- now way under committed
select lives_ok(
  format($$ select start_purchase(%L) $$, :'o3_id'),
  'item 8: lowering the budget below committed spend does not block an existing order from progressing'
);

-- item 9: but a NEW order is now blocked hard
select tests.authenticate_as(:'worker_bg');
select throws_ok(
  format($$ select tests.create_order_1(%L, %L, 'p5', 'Screws', '4x40', 1, 'box', 'SW1A 1AA', null, null, 'b1', 'M', 'm.co.uk', 'SW1 1AA', 'today', 1.00, null, null) $$, :'co', :'capped'),
  '22023', null,
  'item 9: with the budget now below committed spend, any new order is refused'
);

-- item 10: raising the budget lets orders flow again
select tests.authenticate_as(:'owner_bg');
update sites set monthly_budget = 100000 where id = :'capped';
select tests.authenticate_as(:'worker_bg');
select lives_ok(
  format($$ select tests.create_order_1(%L, %L, 'p5', 'Screws', '4x40', 1, 'box', 'SW1A 1AA', null, null, 'b1', 'M', 'm.co.uk', 'SW1 1AA', 'today', 1.00, null, null) $$, :'co', :'capped'),
  'item 10: raising the budget immediately unblocks new orders'
);

-- item 11: the uncapped site has no limit at all
select lives_ok(
  format($$ select tests.create_order_1(%L, %L, 'p1', 'Cement', '25kg', 1000, 'bag', 'SW1A 1AA', null, null, 'b1', 'M', 'm.co.uk', 'SW1 1AA', 'today', 10.00, null, null) $$, :'co', :'uncapped'),
  'item 11: a site with no monthly_budget accepts an order of any size'
);

-- item 12: the CHECK constraint rejects a negative budget (as the owner, who
-- can actually UPDATE sites — a worker's UPDATE would hit RLS first).
select tests.authenticate_as(:'owner_bg');
select throws_ok(
  format($$ update sites set monthly_budget = -5 where id = %L $$, :'uncapped'),
  '23514', null,
  'item 12: a negative monthly_budget is rejected by the CHECK constraint'
);

select finish();
rollback;
