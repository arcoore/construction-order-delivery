-- Company ownership transfer (migration 0028).
begin;
select plan(14);

select tests.create_user('creator-ot@test.local', 'Creator OT')   as creator \gset
select tests.create_user('newowner-ot@test.local', 'New Owner OT') as newowner \gset
select tests.create_user('member-ot@test.local', 'Member OT')      as member \gset
select tests.create_user('stranger-ot@test.local', 'Stranger OT')  as stranger \gset

insert into communities (name, invite_code, owner_id) values ('OT Co', 'OTCO01', :'creator') returning id as co \gset
insert into community_memberships (community_id, user_id, status, decided_by_id) values
  (:'co', :'newowner', 'approved', :'creator'),
  (:'co', :'member', 'approved', :'creator');

-- Part A — signature / grant integrity
select ok(to_regprocedure('public.transfer_ownership(uuid, uuid)') is not null,
  'item 1: transfer_ownership(uuid,uuid) exists');
select ok(has_function_privilege('authenticated', 'transfer_ownership(uuid, uuid)', 'EXECUTE'),
  'item 2: authenticated can execute it');
select ok(not has_function_privilege('anon', 'transfer_ownership(uuid, uuid)', 'EXECUTE'),
  'item 3: anon cannot execute it');

-- Part B — authorization
select tests.authenticate_as(:'stranger');
select throws_ok(format($$ select transfer_ownership(%L, %L) $$, :'co', :'newowner'),
  '42501', null, 'item 4: a stranger cannot transfer ownership');

select tests.authenticate_as(:'member');
select throws_ok(format($$ select transfer_ownership(%L, %L) $$, :'co', :'newowner'),
  '42501', null, 'item 5: an ordinary member cannot transfer ownership');

-- a granted (non-creator) owner also cannot
select tests.authenticate_as(:'creator');
insert into owner_grants (community_id, user_id, granted_by_id) values (:'co', :'member', :'creator');
select tests.authenticate_as(:'member');
select throws_ok(format($$ select transfer_ownership(%L, %L) $$, :'co', :'newowner'),
  '42501', null, 'item 6: a granted (non-creator) owner cannot transfer ownership');
select tests.authenticate_as(:'creator');
delete from owner_grants where community_id = :'co' and user_id = :'member';

select tests.authenticate_as(:'creator');
select throws_ok(format($$ select transfer_ownership(%L, %L) $$, :'co', :'creator'),
  '22023', null, 'item 7: cannot transfer to yourself');
select throws_ok(format($$ select transfer_ownership(%L, %L) $$, :'co', :'stranger'),
  '22023', null, 'item 8: the new owner must be an approved member');

-- Part C — the real transfer
select transfer_ownership(:'co', :'newowner');
select ok((select owner_id = :'newowner' from communities where id = :'co'),
  'item 9: communities.owner_id is now the new owner');
select ok(exists(select 1 from owner_grants where community_id = :'co' and user_id = :'creator' and granted_by_id = :'newowner'),
  'item 10: the outgoing creator keeps owner-level access via a new owner_grant');
select ok(not exists(select 1 from owner_grants where community_id = :'co' and user_id = :'newowner'),
  'item 11: the incoming owner has no redundant owner_grant');
select ok(is_creator(:'co', :'newowner') and not is_creator(:'co', :'creator'),
  'item 12: is_creator now reflects the new owner');
select ok(is_owner(:'co', :'creator'),
  'item 13: the outgoing creator is still an owner (via the grant)');

select tests.authenticate_as(:'newowner');
select ok(exists(select 1 from notifications where recipient_user_id = :'newowner' and type = 'ownership_transferred' and community_id = :'co'),
  'item 14: the new owner receives an ownership_transferred notification');

select finish();
rollback;
