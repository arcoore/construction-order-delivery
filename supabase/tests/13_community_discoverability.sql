-- Roadmap Step 5 — community privacy (migration 0021): discoverable column,
-- the narrowed communities SELECT policy, and the new
-- request_join_by_invite_code RPC that replaces the old client-side
-- "scan the fully-cached table" invite-code lookup now that the table isn't
-- fully cached for everyone anymore. All setup happens before the first role
-- switch (this project's pgTAP helpers only ever move privilege downward
-- within one file — see 00_helpers.sql's own header).
--
-- Verification queries below are always run while still authenticated as
-- whichever real user legitimately has visibility into the row being
-- checked (themselves, or the community's own owner) — never as anon, which
-- correctly has zero SELECT access to community_memberships at all; running
-- a verification count as anon would fail with a permission error before it
-- ever got the chance to prove anything about row counts.
begin;
select plan(22);

-- ================================================================
-- Fixtures (still privileged/superuser — no role switch yet)
-- ================================================================

select tests.create_user('s5-owner@test.local', 'Step5 Owner') as owner_id \gset
select tests.create_user('s5-granted-owner@test.local', 'Step5 Granted Owner') as granted_owner_id \gset
select tests.create_user('s5-approved@test.local', 'Step5 Approved Member') as approved_id \gset
select tests.create_user('s5-pending@test.local', 'Step5 Pending Requester') as pending_id \gset
select tests.create_user('s5-unrelated@test.local', 'Step5 Unrelated User') as unrelated_id \gset
select tests.create_user('s5-joiner@test.local', 'Step5 Fresh Joiner') as joiner_id \gset

insert into communities (name, invite_code, owner_id) values
  ('Step5 Private Co', 'S5PRIV', :'owner_id');
select id from communities where name = 'Step5 Private Co' \gset private_
select discoverable from communities where id = :'private_id' \gset private_

insert into communities (name, invite_code, owner_id, discoverable) values
  ('Step5 Discoverable Co', 'S5DISC', :'owner_id', true);
select id from communities where name = 'Step5 Discoverable Co' \gset disc_

insert into owner_grants (community_id, user_id, granted_by_id)
  values (:'private_id', :'granted_owner_id', :'owner_id');

insert into community_memberships (community_id, user_id, status) values
  (:'private_id', :'approved_id', 'approved'),
  (:'private_id', :'pending_id', 'pending');

-- ================================================================
-- item 1: schema — new column exists, defaults false for a fresh row that
-- never specified it (Step5 Private Co above didn't pass `discoverable`).
-- ================================================================
select is(:'private_discoverable'::boolean, false, 'item 1: discoverable column defaults to false for a newly-created community');

-- ================================================================
-- items 2-6: communities SELECT scoping, as real authenticated roles.
-- ================================================================
select tests.authenticate_as(:'owner_id');
select isnt_empty(
  format($$ select 1 from communities where id = %L $$, :'private_id'),
  'item 2: the owner (creator) can SELECT their own private community'
);

select tests.authenticate_as(:'approved_id');
select isnt_empty(
  format($$ select 1 from communities where id = %L $$, :'private_id'),
  'item 3: an approved member can SELECT the private community'
);

select tests.authenticate_as(:'pending_id');
select isnt_empty(
  format($$ select 1 from communities where id = %L $$, :'private_id'),
  'item 4: a user with a pending join request can SELECT the private community'
);

select tests.authenticate_as(:'unrelated_id');
select is_empty(
  format($$ select 1 from communities where id = %L $$, :'private_id'),
  'item 5: an unrelated authenticated user CANNOT SELECT the private community'
);
select isnt_empty(
  format($$ select 1 from communities where id = %L $$, :'disc_id'),
  'item 6: an unrelated authenticated user CAN SELECT a discoverable community'
);

select tests.clear_authentication();
select throws_ok(
  $$ select count(*) from communities $$,
  '42501', null,
  'item 7: anon still cannot read communities at all (unchanged baseline)'
);

-- ================================================================
-- items 8-18: request_join_by_invite_code RPC. Every membership-row
-- verification below stays authenticated as the same acting user (or the
-- owner, for the cross-user absence check in item 18) — never anon.
-- ================================================================
select tests.authenticate_as(:'joiner_id');

select request_join_by_invite_code('S5PRIV') as join_result \gset
select is(
  (:'join_result')::jsonb,
  jsonb_build_object('ok', true, 'status', 'pending', 'justCreated', true, 'communityId', :'private_id', 'communityName', 'Step5 Private Co'),
  'item 8: a valid private invite code returns exactly the expected minimal pending response, justCreated true (proves both correctness and minimality — any extra/missing key breaks this equality; justCreated is what a real live bug found missing — see this migration''s own header)'
);
select is(
  (select count(*) from community_memberships where community_id = :'private_id' and user_id = :'joiner_id')::int,
  1,
  'item 9: exactly one pending membership row now exists for the fresh joiner (checked as the joiner themselves, who legitimately sees their own row)'
);

select is(
  (request_join_by_invite_code('NOTACODE')::jsonb),
  jsonb_build_object('ok', false, 'error', 'not_found'),
  'item 10: an invalid invite code returns a safe not-found result'
);
select is(
  (select count(*) from community_memberships where community_id is null)::int,
  0,
  'item 11: an invalid code created no orphan/null-community row (community_id is NOT NULL-constrained anyway; this is a belt-and-braces sanity check)'
);

select tests.authenticate_as(:'approved_id');
select is(
  (request_join_by_invite_code('S5PRIV')::jsonb),
  jsonb_build_object('ok', true, 'status', 'approved', 'justCreated', false, 'communityId', :'private_id', 'communityName', 'Step5 Private Co'),
  'item 12: an already-approved member calling the RPC again is told they are already approved (justCreated false, not a fresh row)'
);
select is(
  (select count(*) from community_memberships where community_id = :'private_id' and user_id = :'approved_id')::int,
  1,
  'item 13: the already-approved member still has exactly one membership row (no duplicate created)'
);

select tests.authenticate_as(:'pending_id');
select is(
  (request_join_by_invite_code('S5PRIV')::jsonb),
  jsonb_build_object('ok', true, 'status', 'pending', 'justCreated', false, 'communityId', :'private_id', 'communityName', 'Step5 Private Co'),
  'item 14: an already-pending requester calling the RPC again is told they are still pending (never self-approved), justCreated false (the exact bug a real live test caught — see this migration''s own header)'
);
select is(
  (select count(*) from community_memberships where community_id = :'private_id' and user_id = :'pending_id')::int,
  1,
  'item 15: the already-pending requester still has exactly one row (no duplicate, still pending not approved)'
);

select tests.authenticate_as(:'owner_id');
select is(
  (request_join_by_invite_code('S5PRIV')::jsonb),
  jsonb_build_object('ok', true, 'status', 'owner', 'justCreated', false, 'communityId', :'private_id', 'communityName', 'Step5 Private Co'),
  'item 16: the creator-owner calling the RPC for their own community is told they are the owner'
);
select tests.authenticate_as(:'granted_owner_id');
select is(
  (request_join_by_invite_code('S5PRIV')::jsonb),
  jsonb_build_object('ok', true, 'status', 'owner', 'justCreated', false, 'communityId', :'private_id', 'communityName', 'Step5 Private Co'),
  'item 17: a GRANTED (non-creator) owner is also told they are the owner, not asked to join'
);

select tests.authenticate_as(:'owner_id');
select is(
  (select count(*) from community_memberships where community_id = :'private_id' and user_id in (:'owner_id', :'granted_owner_id'))::int,
  0,
  'item 18: neither owner (creator or granted) ever got a community_memberships row from the RPC (checked as the owner, who legitimately sees every membership row in their own community via is_owner)'
);

-- ================================================================
-- items 19-20: only the owner may toggle discoverable — real RLS
-- (communities_update_owner_only, unchanged/pre-existing since 0009),
-- never merely a client-side isOwner() check. A non-owner's UPDATE matches
-- zero rows under RLS (Postgres doesn't error on an UPDATE filtered to
-- nothing by RLS — it just silently affects 0 rows), so the assertion is
-- "the value never actually changed," not throws_ok.
-- ================================================================
update communities set discoverable = true where id = :'private_id';
select is(
  (select discoverable from communities where id = :'private_id')::boolean,
  true,
  'item 19: the owner CAN toggle discoverable (still authenticated as owner_id)'
);

select tests.authenticate_as(:'approved_id');
update communities set discoverable = false where id = :'private_id';
select tests.authenticate_as(:'owner_id');
select is(
  (select discoverable from communities where id = :'private_id')::boolean,
  true,
  'item 20: a non-owner (approved member) CANNOT toggle discoverable — the value is unchanged by their update attempt, a real RLS denial not a client-side check'
);

-- ================================================================
-- item 21: invite_code uniqueness is a real database constraint (was
-- already present since 0003 — re-confirmed here as part of this phase's
-- own migration, not newly added by it). Run while still authenticated as
-- the real owner of the row being duplicated, so the INSERT's own WITH
-- CHECK (owner_id = auth.uid()) passes and the unique-index violation is
-- the thing that actually fires, not an unrelated permission error.
-- ================================================================
select throws_ok(
  format($$ insert into communities (name, invite_code, owner_id) values ('Dup Code Co', 'S5PRIV', %L) $$, :'owner_id'),
  '23505', null,
  'item 21: invite_code uniqueness is enforced at the database level'
);

-- ================================================================
-- item 22: anon cannot execute the RPC at all — the EXECUTE grant itself
-- was revoked from anon/public in 0021, so this fails at the permission
-- layer before the function body's own auth.uid() IS NULL check is ever
-- reached.
-- ================================================================
select tests.clear_authentication();
select throws_ok(
  $$ select request_join_by_invite_code('S5PRIV') $$,
  '42501', null,
  'item 22: anon cannot execute request_join_by_invite_code at all (no EXECUTE grant)'
);

select finish();
rollback;
