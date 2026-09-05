-- Notification retention (migration 0029).
begin;
select plan(7);

select tests.create_user('owner-nr@test.local', 'Owner NR')   as owner_nr \gset
select tests.create_user('worker-nr@test.local', 'Worker NR') as worker_nr \gset
insert into communities (name, invite_code, owner_id) values ('NR Co', 'NRCO01', :'owner_nr') returning id as co \gset

-- Seed three notifications directly (privileged, still the ambient role):
-- one old+read (should be pruned), one old+unread (kept), one recent+read (kept).
insert into notifications (recipient_user_id, type, category, title, message, community_id, read, read_at, created_at)
values
  (:'worker_nr', 'order_delivered', 'deliveryUpdates', 'Old read', 'x', :'co', true,  now() - interval '100 days', now() - interval '100 days'),
  (:'worker_nr', 'order_delivered', 'deliveryUpdates', 'Old unread', 'x', :'co', false, null,                       now() - interval '100 days'),
  (:'worker_nr', 'order_delivered', 'deliveryUpdates', 'Recent read', 'x', :'co', true,  now() - interval '2 days',  now() - interval '2 days');

select is((select count(*)::int from notifications where recipient_user_id = :'worker_nr'), 3,
  'item 1: three notifications seeded');

select ok(prune_notifications() >= 1, 'item 2: prune_notifications() reports at least one row deleted');

select is((select count(*)::int from notifications where recipient_user_id = :'worker_nr'), 2,
  'item 3: exactly one notification was pruned');
select ok(not exists(select 1 from notifications where recipient_user_id = :'worker_nr' and title = 'Old read'),
  'item 4: the old + read notification is gone');
select ok(exists(select 1 from notifications where recipient_user_id = :'worker_nr' and title = 'Old unread'),
  'item 5: an old but UNREAD notification is kept');
select ok(exists(select 1 from notifications where recipient_user_id = :'worker_nr' and title = 'Recent read'),
  'item 6: a recently-read notification is kept');

-- The maintenance function is not client-callable.
select ok(
  not has_function_privilege('authenticated', 'prune_notifications()', 'EXECUTE')
  and not has_function_privilege('anon', 'prune_notifications()', 'EXECUTE'),
  'item 7: neither authenticated nor anon can execute prune_notifications()'
);

select finish();
rollback;
