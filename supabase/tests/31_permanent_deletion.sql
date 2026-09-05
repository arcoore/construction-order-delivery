-- Permanent deletion (migration 0038). delete_site: owner only, no orders.
-- delete_community: creator only, no orders/sites/other-members.
begin;
select plan(14);

select tests.create_user('owner-pd@test.local', 'Owner PD')   as owner_pd \gset
select tests.create_user('worker-pd@test.local', 'Worker PD') as worker_pd \gset

-- All fixture rows created here, as the raw superuser (bypasses RLS) — the
-- authenticated sections below only exercise the delete RPCs themselves.
insert into communities (name, invite_code, owner_id, require_owner_approval)
  values ('PD Co', 'PDCO01', :'owner_pd', false) returning id as co \gset
insert into sites (community_id, name, created_by_id) values (:'co', 'Empty Site', :'owner_pd') returning id as empty_site \gset
insert into sites (community_id, name, created_by_id) values (:'co', 'Used Site', :'owner_pd') returning id as used_site \gset
insert into community_memberships (community_id, user_id, status, decided_by_id)
  values (:'co', :'worker_pd', 'approved', :'owner_pd');
insert into site_memberships (site_id, community_id, user_id, added_by_id) values
  (:'empty_site', :'co', :'worker_pd', :'owner_pd'),
  (:'used_site', :'co', :'worker_pd', :'owner_pd');

-- three companies for the delete_community matrix
insert into communities (name, invite_code, owner_id) values ('Has Member Co', 'HASMEM', :'owner_pd') returning id as co_member \gset
insert into community_memberships (community_id, user_id, status, decided_by_id) values (:'co_member', :'worker_pd', 'approved', :'owner_pd');
insert into communities (name, invite_code, owner_id) values ('Has Site Co', 'HASSIT', :'owner_pd') returning id as co_site \gset
insert into sites (community_id, name, created_by_id) values (:'co_site', 'x', :'owner_pd');
insert into communities (name, invite_code, owner_id) values ('Pristine Co', 'PRIST1', :'owner_pd') returning id as pristine \gset

-- an order against Used Site
select tests.authenticate_as(:'worker_pd');
select tests.create_order_1(:'co', :'used_site', 'p1', 'Cement', '25kg', 1, 'bag', 'SW1A 1AA', null, null, 'b1', 'M', 'm.co.uk', 'SW1 1AA', 'today', 10.00, null, null);

-- item 1: a non-owner can't delete a site
select throws_ok(format($$ select delete_site(%L) $$, :'empty_site'), '42501', null, 'item 1: a non-owner cannot delete a site');

select tests.authenticate_as(:'owner_pd');
select throws_ok(format($$ select delete_site(%L) $$, :'used_site'), '42501', null, 'item 2: a site with orders on file cannot be deleted');
select lives_ok(format($$ select delete_site(%L) $$, :'empty_site'), 'item 3: an owner deletes an order-free site');
select is((select count(*) from sites where id = :'empty_site')::int, 0, 'item 4: the site row is gone');
select is((select count(*) from site_memberships where site_id = :'empty_site')::int, 0, 'item 5: its memberships are gone');
select throws_ok(format($$ select delete_site(%L) $$, :'empty_site'), '42704', null, 'item 6: deleting an already-gone site is 42704');

-- ---- delete_community ----
select tests.authenticate_as(:'worker_pd');
select throws_ok(format($$ select delete_community(%L) $$, :'co'), '42501', null, 'item 7: a non-creator cannot delete the company');

select tests.authenticate_as(:'owner_pd');
select throws_ok(format($$ select delete_community(%L) $$, :'co'), '42501', null, 'item 8: a company with orders cannot be deleted');
select throws_ok(format($$ select delete_community(%L) $$, :'co_member'), '42501', null, 'item 9: a company with another member cannot be deleted');
select throws_ok(format($$ select delete_community(%L) $$, :'co_site'), '42501', null, 'item 10: a company with a site cannot be deleted');

select lives_ok(format($$ select delete_community(%L) $$, :'pristine'), 'item 11: a pristine company is deleted');
select is((select count(*) from communities where id = :'pristine')::int, 0, 'item 12: the company row is gone');
select is((select count(*) from community_memberships where community_id = :'pristine')::int, 0, 'item 13: memberships cascaded');

select tests.clear_authentication();
select throws_ok(format($$ select delete_community(%L) $$, :'co'), '42501', null, 'item 14: anon cannot execute delete_community');

select finish();
rollback;
