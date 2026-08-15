-- Covers audit items 1-9, 17, 20: cross-company isolation, duplicate
-- display names, site access, buyer authorization, owner scope, revoked
-- membership, and "knowing a UUID grants nothing."
begin;
select plan(15);

-- ---- fixtures: two companies, deliberately never letting company B's
-- owner or members touch company A's rows. owner_a/owner_b share a display
-- name on purpose (item 3) — the comment lives on its own line because
-- \gset treats the rest of its line as arguments, not SQL, so a trailing
-- "-- comment" on the same line is parsed as garbage and breaks it.
select tests.create_user('owner-a@test.local', 'Same Name')          as owner_a \gset
select tests.create_user('owner-b@test.local', 'Same Name')          as owner_b \gset
select tests.create_user('worker-a@test.local', 'Worker A')          as worker_a \gset
select tests.create_user('worker-b@test.local', 'Worker B')          as worker_b \gset
select tests.create_user('buyer-a@test.local', 'Buyer A')            as buyer_a \gset
select tests.create_user('outsider@test.local', 'Outsider')          as outsider \gset

select tests.authenticate_as(:'owner_a');
insert into communities (name, invite_code, owner_id) values ('Company A', 'AAAAAA', :'owner_a') returning id as company_a \gset

select tests.authenticate_as(:'owner_b');
insert into communities (name, invite_code, owner_id) values ('Company B', 'BBBBBB', :'owner_b') returning id as company_b \gset

-- worker_a requests + gets approved into Company A only.
select tests.authenticate_as(:'worker_a');
insert into community_memberships (community_id, user_id, status) values (:'company_a', :'worker_a', 'pending');
select tests.authenticate_as(:'owner_a');
update community_memberships set status = 'approved', decided_by_id = :'owner_a' where community_id = :'company_a' and user_id = :'worker_a';

select tests.authenticate_as(:'owner_a');
insert into sites (community_id, name, created_by_id) values (:'company_a', 'Site Alpha', :'owner_a') returning id as site_a \gset
insert into site_memberships (site_id, community_id, user_id, added_by_id) values (:'site_a', :'company_a', :'worker_a', :'owner_a');

select tests.authenticate_as(:'owner_a');
insert into buyer_grants (community_id, user_id, granted_by_id) values (:'company_a', :'buyer_a', :'owner_a');
-- buyer_a is NOT a site member yet — item 6 needs both.

-- ---------------------------------------------------- 1/2: cross-company read
-- NOTE: `communities` itself is deliberately world-readable to any
-- authenticated user (communities_select_any using (true)) — it backs the
-- real product's "Browse communities" feature, matching community.js's own
-- design. Cross-company isolation is enforced on the resources INSIDE a
-- company (memberships, sites, orders, ...), not the community row's own
-- name/invite-code visibility, so item 1 tests a genuinely protected table.
select tests.authenticate_as(:'owner_b');
select is( (select count(*) from community_memberships where community_id = :'company_a')::int, 0,
  'owner B cannot select company A''s membership rows via RLS (item 1: cross-company read isolation)');

select is_empty(
  $$ select 1 from sites where community_id = (select id from communities where invite_code = 'AAAAAA') $$,
  'owner B sees zero of company A''s sites'
);

-- ---------------------------------------------------- 2: cross-company write
select throws_ok(
  format($$ insert into sites (community_id, name, created_by_id) values (%L, 'Hostile Site', %L) $$, :'company_a', :'owner_b'),
  '42501',
  null,
  'owner B cannot INSERT a site into company A (item 2: cross-company write isolation)'
);

-- ---------------------------------------------------- 3: duplicate display names
select isnt(
  (select id from profiles where id = :'owner_a'),
  (select id from profiles where id = :'owner_b'),
  'two profiles named "Same Name" remain distinct rows keyed by id (item 3)'
);
select is(
  (select count(*) from profiles where display_name = 'Same Name')::int, 2,
  'both duplicate-named profiles exist independently, no collision'
);

-- ---------------------------------------------------- 4/5: worker site access
select tests.authenticate_as(:'worker_a');
select ok( can_access_site(:'site_a', :'company_a', :'worker_a'),
  'worker A can access Site Alpha, the site they were actually assigned to (item 4)');

select tests.authenticate_as(:'owner_b');
insert into sites (community_id, name, created_by_id) values (:'company_b', 'Site Beta', :'owner_b') returning id as site_b \gset
select tests.authenticate_as(:'worker_a');
select ok( not can_access_site(:'site_b', :'company_b', :'worker_a'),
  'worker A is refused access to Site Beta in a different company (item 5)');

-- ---------------------------------------------------- 6: buyer requires grant AND site membership
select tests.authenticate_as(:'buyer_a');
select ok( not can_purchase_for_site(:'site_a', :'company_a', :'buyer_a'),
  'a buyer grant alone is NOT enough without site membership (item 6)');
select tests.authenticate_as(:'owner_a');
insert into site_memberships (site_id, community_id, user_id, added_by_id) values (:'site_a', :'company_a', :'buyer_a', :'owner_a');
select tests.authenticate_as(:'buyer_a');
select ok( can_purchase_for_site(:'site_a', :'company_a', :'buyer_a'),
  'buyer grant + site membership together is authorized (item 6)');

-- ---------------------------------------------------- 7/8: owner scope
select tests.authenticate_as(:'owner_a');
select ok( can_access_site(:'site_a', :'company_a', :'owner_a'),
  'owner A can access every site in their own company without explicit site membership (item 7)');
select ok( not can_access_site(:'site_b', :'company_b', :'owner_a'),
  'owner A''s company-wide bypass does not extend into company B (item 8)');

-- ---------------------------------------------------- 17: revoked membership fails next action
select tests.authenticate_as(:'owner_a');
update community_memberships set status = 'declined' where community_id = :'company_a' and user_id = :'worker_a';
select tests.authenticate_as(:'worker_a');
select ok( not is_approved_member(:'company_a', :'worker_a'),
  'worker A''s next permission check reflects the revocation immediately (item 17)');
-- restore for later tests in this file
select tests.authenticate_as(:'owner_a');
update community_memberships set status = 'approved' where community_id = :'company_a' and user_id = :'worker_a';

-- ---------------------------------------------------- 20: knowing a UUID grants nothing
select tests.authenticate_as(:'outsider');
select ok( not can_access_site(:'site_a', :'company_a', :'outsider'),
  'an outsider who merely knows site_a''s real UUID still cannot access it (item 20)');
select is_empty(
  format($$ select 1 from orders where site_id = %L $$, :'site_a'),
  'an outsider selects zero rows from orders scoped to a known site UUID'
);
select throws_ok(
  format($$ insert into site_memberships (site_id, community_id, user_id, added_by_id) values (%L, %L, %L, %L) $$,
    :'site_a', :'company_a', :'outsider', :'outsider'),
  '42501',
  null,
  'an outsider cannot self-add to a site whose UUID they know'
);

select finish();
rollback;
