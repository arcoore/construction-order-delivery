-- Rate limits on orders/order_messages (migration 0050): a per-requester
-- and per-author rolling-60s cap, mirroring 0047's client_errors shape.
begin;
select plan(10);

select tests.create_user('owner-rl@test.local', 'Owner RL')   as owner_rl \gset
select tests.create_user('worker-rl@test.local', 'Worker RL') as worker_rl \gset
select tests.create_user('worker-rl2@test.local', 'Worker RL2') as worker_rl2 \gset

insert into communities (name, invite_code, owner_id, require_owner_approval)
  values ('RL Co', 'RLCO01', :'owner_rl', false) returning id as co \gset
insert into sites (community_id, name, created_by_id)
  values (:'co', 'RL Site', :'owner_rl') returning id as site \gset

-- ---- orders -------------------------------------------------------------
select lives_ok(
  format($$ insert into orders (community_id, site_id, site_name, product_name, delivery_postcode, requested_by_id, requested_by)
            values ('%s','%s','RL Site','Item','KT17 2AD','%s','Worker RL') $$, :'co', :'site', :'worker_rl'),
  'item 1: a normal single order is accepted');

insert into orders (community_id, site_id, site_name, product_name, delivery_postcode, requested_by_id, requested_by)
select :'co', :'site', 'RL Site', 'Item ' || g, 'KT17 2AD', :'worker_rl', 'Worker RL'
from generate_series(1, 19) g;
select is((select count(*)::int from orders where requested_by_id = :'worker_rl'), 20,
  'item 2: 20 orders from the same requester now sit in the window');

select throws_ok(
  format($$ insert into orders (community_id, site_id, site_name, product_name, delivery_postcode, requested_by_id, requested_by)
            values ('%s','%s','RL Site','One too many','KT17 2AD','%s','Worker RL') $$, :'co', :'site', :'worker_rl'),
  '53400', 'orders: too many orders placed too quickly, please slow down',
  'item 3: the 21st order from the same requester inside the window is refused');

select lives_ok(
  format($$ insert into orders (community_id, site_id, site_name, product_name, delivery_postcode, requested_by_id, requested_by)
            values ('%s','%s','RL Site','Different requester','KT17 2AD','%s','Worker RL2') $$, :'co', :'site', :'worker_rl2'),
  'item 4: a DIFFERENT requester is unaffected by the first one''s count');

update orders set created_at = created_at - interval '61 seconds' where requested_by_id = :'worker_rl';
select lives_ok(
  format($$ insert into orders (community_id, site_id, site_name, product_name, delivery_postcode, requested_by_id, requested_by)
            values ('%s','%s','RL Site','After the window','KT17 2AD','%s','Worker RL') $$, :'co', :'site', :'worker_rl'),
  'item 5: once the 60s window rolls past, that requester can order again');

-- ---- order_messages -------------------------------------------------------
insert into orders (community_id, site_id, site_name, product_name, delivery_postcode, requested_by_id, requested_by)
  values (:'co', :'site', 'RL Site', 'Message thread order', 'KT17 2AD', :'owner_rl', 'Owner RL')
  returning id as msg_order \gset

select lives_ok(
  format($$ insert into order_messages (order_id, community_id, author_id, author_name, body)
            values ('%s','%s','%s','Worker RL','hello') $$, :'msg_order', :'co', :'worker_rl'),
  'item 6: a normal single message is accepted');

insert into order_messages (order_id, community_id, author_id, author_name, body)
select :'msg_order', :'co', :'worker_rl', 'Worker RL', 'msg ' || g
from generate_series(1, 19) g;
select is((select count(*)::int from order_messages where author_id = :'worker_rl'), 20,
  'item 7: 20 messages from the same author now sit in the window');

select throws_ok(
  format($$ insert into order_messages (order_id, community_id, author_id, author_name, body)
            values ('%s','%s','%s','Worker RL','one too many') $$, :'msg_order', :'co', :'worker_rl'),
  '53400', 'order_messages: too many messages sent too quickly, please slow down',
  'item 8: the 21st message from the same author inside the window is refused');

select lives_ok(
  format($$ insert into order_messages (order_id, community_id, author_id, author_name, body)
            values ('%s','%s','%s','Owner RL','different author') $$, :'msg_order', :'co', :'owner_rl'),
  'item 9: a DIFFERENT author is unaffected by the first one''s count');

update order_messages set created_at = created_at - interval '61 seconds' where author_id = :'worker_rl';
select lives_ok(
  format($$ insert into order_messages (order_id, community_id, author_id, author_name, body)
            values ('%s','%s','%s','Worker RL','after the window') $$, :'msg_order', :'co', :'worker_rl'),
  'item 10: once the 60s window rolls past, that author can message again');

select finish();
rollback;
