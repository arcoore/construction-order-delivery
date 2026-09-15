-- Free/Premium plans (migration 0052): the Free plan is capped at 2
-- non-archived sites per company; Premium removes the cap. The cap is
-- enforced server-side by a trigger, not by the client - and `premium`
-- itself can only be changed by a direct-SQL/service-role caller, never
-- through the normal authenticated app API.
begin;
select plan(11);

select tests.create_user('owner-pl@test.local', 'Owner PL') as owner_pl \gset

insert into communities (name, invite_code, owner_id)
  values ('PL Co', 'PLCO01', :'owner_pl') returning id as co \gset

select tests.authenticate_as(:'owner_pl');

-- item 1 & 2: the first two sites on the Free plan are fine
select lives_ok(
  format($$ insert into sites (community_id, name, created_by_id) values (%L, 'Site A', %L) $$, :'co', :'owner_pl'),
  'item 1: the first site on the Free plan is allowed');
select lives_ok(
  format($$ insert into sites (community_id, name, created_by_id) values (%L, 'Site B', %L) $$, :'co', :'owner_pl'),
  'item 2: the second site on the Free plan is allowed');

-- item 3: a third is refused
select throws_ok(
  format($$ insert into sites (community_id, name, created_by_id) values (%L, 'Site C', %L) $$, :'co', :'owner_pl'),
  '22023', null,
  'item 3: a third site on the Free plan is refused');

-- item 4: archiving one frees a slot
update sites set status = 'archived' where community_id = :'co' and name = 'Site A';
select lives_ok(
  format($$ insert into sites (community_id, name, created_by_id) values (%L, 'Site C', %L) $$, :'co', :'owner_pl'),
  'item 4: archiving a site frees a slot for a new one');

-- item 5: restoring the archived site back over the cap is refused too -
-- otherwise archive+restore would be a free way around the limit
select throws_ok(
  format($$ update sites set status = 'active' where community_id = %L and name = 'Site A' $$, :'co'),
  '22023', null,
  'item 5: restoring an archived site is refused once it would exceed the cap');

-- item 6: an unrelated edit to an existing site is unaffected (still at the cap)
select lives_ok(
  format($$ update sites set delivery_instructions = 'Use the side gate' where community_id = %L and name = 'Site B' $$, :'co'),
  'item 6: editing an unrelated field on an existing site is never blocked by the cap');

-- item 7: a plain status change between two non-archived statuses is unaffected
select lives_ok(
  format($$ update sites set status = 'paused' where community_id = %L and name = 'Site B' $$, :'co'),
  'item 7: pausing a site (not archiving) is never blocked by the cap');

-- item 8: the owner can't self-upgrade by flipping premium through the app
select throws_ok(
  format($$ update communities set premium = true where id = %L $$, :'co'),
  '42501', null,
  'item 8: an authenticated owner cannot flip premium themselves');
reset role;
select is((select premium from communities where id = :'co'), false, 'item 9: premium is still false after the refused attempt');

-- item 10: direct SQL (the founder, via the dashboard/psql) CAN set it -
-- `reset role` above put this session back to the superuser role the test
-- suite itself connects as, exactly like a real dashboard/psql session.
update communities set premium = true where id = :'co';
select is((select premium from communities where id = :'co'), true, 'item 10: direct SQL can flip premium');

-- item 11: once premium, the site cap no longer applies
select tests.authenticate_as(:'owner_pl');
select lives_ok(
  format($$ insert into sites (community_id, name, created_by_id) values (%L, 'Site D', %L) $$, :'co', :'owner_pl'),
  'item 11: a Premium company can add unlimited sites');

select finish();
rollback;
