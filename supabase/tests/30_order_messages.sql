-- Per-order message threads (migration 0037). Anyone who can see the order
-- can read and post via send_order_message; nobody else can; messages are
-- append-only; author_name is server-set.
begin;
select plan(13);

select tests.create_user('owner-om@test.local', 'Owner OM')     as owner_om \gset
select tests.create_user('worker-om@test.local', 'Worker OM')   as worker_om \gset
select tests.create_user('buyer-om@test.local', 'Buyer OM')     as buyer_om \gset
select tests.create_user('driver-om@test.local', 'Driver OM')   as driver_om \gset
select tests.create_user('stranger-om@test.local', 'Stranger OM') as stranger_om \gset

insert into communities (name, invite_code, owner_id, require_owner_approval)
  values ('OM Co', 'OMCO01', :'owner_om', false) returning id as co \gset
insert into sites (community_id, name, created_by_id) values (:'co', 'OM Site', :'owner_om') returning id as site \gset
insert into community_memberships (community_id, user_id, status, decided_by_id) values
  (:'co', :'worker_om', 'approved', :'owner_om'),
  (:'co', :'buyer_om', 'approved', :'owner_om'),
  (:'co', :'driver_om', 'approved', :'owner_om'),
  (:'co', :'stranger_om', 'approved', :'owner_om');
insert into site_memberships (site_id, community_id, user_id, added_by_id) values
  (:'site', :'co', :'worker_om', :'owner_om'),
  (:'site', :'co', :'buyer_om', :'owner_om');
insert into buyer_grants (community_id, user_id, granted_by_id) values (:'co', :'buyer_om', :'owner_om');

-- an order at 'claimed' so the driver is assigned
select tests.authenticate_as(:'worker_om');
select tests.create_order_1(:'co', :'site', 'p1', 'Cement', '25kg', 5, 'bag', 'SW1A 1AA', null, null, 'b1', 'M', 'm.co.uk', 'SW1 1AA', 'today', 10.00, null, null) as o1 \gset
select (:'o1'::orders).id as o1_id \gset
select tests.authenticate_as(:'buyer_om');
select start_purchase(:'o1_id'); select complete_purchase(:'o1_id');
select tests.authenticate_as(:'driver_om');
select claim_delivery(:'o1_id');

-- item 1-4: each role who can see the order can post
select tests.authenticate_as(:'worker_om');
select (send_order_message(:'o1_id', 'Where is the cement?')).id as m_worker \gset
select ok(:'m_worker' is not null, 'item 1: the requester can post');

select tests.authenticate_as(:'owner_om');
select (send_order_message(:'o1_id', 'Checking with the buyer')).id as m_owner \gset
select ok(:'m_owner' is not null, 'item 2: an owner can post');

select tests.authenticate_as(:'buyer_om');
select (send_order_message(:'o1_id', 'Bought, driver assigned')).id as m_buyer \gset
select ok(:'m_buyer' is not null, 'item 3: a buyer for the site can post');

select tests.authenticate_as(:'driver_om');
select (send_order_message(:'o1_id', 'On my way')).id as m_driver \gset
select ok(:'m_driver' is not null, 'item 4: the assigned driver can post');

-- item 5: author_name is server-set from the caller's own display name
select is((select author_name from order_messages where id = :'m_worker'), 'Worker OM',
  'item 5: author_name is the caller''s real display name, not client-supplied');

-- item 6: everyone who can see the order sees all four messages
select tests.authenticate_as(:'owner_om');
select is((select count(*) from order_messages where order_id = :'o1_id')::int, 4,
  'item 6: a viewer sees the whole thread');

-- item 7-8: a stranger (approved company member, not on the site, not owner)
-- can neither read nor post
select tests.authenticate_as(:'stranger_om');
select is((select count(*) from order_messages where order_id = :'o1_id')::int, 0,
  'item 7: a non-site-member sees no messages (RLS)');
select throws_ok(
  format($$ select send_order_message(%L, 'let me in') $$, :'o1_id'),
  '42501', null,
  'item 8: a non-site-member cannot post'
);

-- item 9: anon cannot execute the RPC at all
select tests.clear_authentication();
select throws_ok(
  format($$ select send_order_message(%L, 'anon') $$, :'o1_id'),
  '42501', null,
  'item 9: anon cannot execute send_order_message'
);

-- item 10-11: empty / whitespace / oversized bodies are rejected
select tests.authenticate_as(:'worker_om');
select throws_ok(
  format($$ select send_order_message(%L, '   ') $$, :'o1_id'),
  '22023', null,
  'item 10: a blank message is rejected'
);
select throws_ok(
  format($$ select send_order_message(%L, repeat('x', 2001)) $$, :'o1_id'),
  '22023', null,
  'item 11: an over-2000-char message is rejected'
);

-- item 12: messages are append-only (no update/delete grant for authenticated)
select throws_ok(
  format($$ update order_messages set body = 'edited' where id = %L $$, :'m_worker'),
  '42501', null,
  'item 12: authenticated has no UPDATE on order_messages'
);
select throws_ok(
  format($$ delete from order_messages where id = %L $$, :'m_worker'),
  '42501', null,
  'item 13: authenticated has no DELETE on order_messages'
);

select finish();
rollback;
