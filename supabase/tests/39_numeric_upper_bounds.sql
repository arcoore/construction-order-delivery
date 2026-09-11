-- Upper bounds on quantity/price/budget/threshold (migration 0051).
begin;
select plan(6);

select tests.create_user('owner-nb@test.local', 'Owner NB') as owner_nb \gset
insert into communities (name, invite_code, owner_id, require_owner_approval)
  values ('NB Co', 'NBCO01', :'owner_nb', false) returning id as co \gset
insert into sites (community_id, name, created_by_id)
  values (:'co', 'NB Site', :'owner_nb') returning id as site \gset
insert into orders (community_id, site_id, site_name, product_name, delivery_postcode, requested_by_id, requested_by)
  values (:'co', :'site', 'NB Site', 'Item', 'KT17 2AD', :'owner_nb', 'Owner NB') returning id as ord \gset

select throws_ok(
  format($$ insert into order_items (order_id, community_id, product_id, product_name, quantity, unit)
            values ('%s','%s','p1','Item',1000001,'each') $$, :'ord', :'co'),
  '23514', null, 'item 1: a quantity over the ceiling is refused');

select lives_ok(
  format($$ insert into order_items (order_id, community_id, product_id, product_name, quantity, unit)
            values ('%s','%s','p1','Item',1000000,'each') $$, :'ord', :'co'),
  'item 2: exactly the ceiling is accepted');

select throws_ok(
  format($$ insert into order_items (order_id, community_id, product_id, product_name, quantity, unit, unit_price)
            values ('%s','%s','p2','Item 2',1,'each',10000001) $$, :'ord', :'co'),
  '23514', null, 'item 3: a unit_price over the ceiling is refused');

select throws_ok(
  format($$ update sites set monthly_budget = 100000001 where id = '%s' $$, :'site'),
  '23514', null, 'item 4: a site monthly_budget over the ceiling is refused');
select lives_ok(
  format($$ update sites set monthly_budget = 5000 where id = '%s' $$, :'site'),
  'item 5: a realistic site monthly_budget is unaffected');

select throws_ok(
  format($$ update communities set approval_threshold = 100000001 where id = '%s' $$, :'co'),
  '23514', null, 'item 6: a community approval_threshold over the ceiling is refused');

select finish();
rollback;
