-- Site contacts + expanded status (migration 0027).
begin;
select plan(8);

select tests.create_user('owner-cs@test.local', 'Owner CS') as owner_cs \gset
insert into communities (name, invite_code, owner_id) values ('CS Co', 'CSCO01', :'owner_cs') returning id as co \gset

select tests.authenticate_as(:'owner_cs');

select lives_ok(
  format($$ insert into sites (community_id, name, created_by_id, site_contact_name, site_contact_phone, access_notes)
            values (%L, 'Contacts site', %L, 'Dave', '07700 900123', 'Gate code 1234') $$, :'co', :'owner_cs'),
  'item 1: site contact columns accept values'
);
select id as site_id from sites where name = 'Contacts site' and community_id = :'co' \gset

select ok((select site_contact_name = 'Dave' and access_notes = 'Gate code 1234' from sites where id = :'site_id'),
  'item 2: contact fields round-trip');

select ok((select status = 'active' from sites where id = :'site_id'),
  'item 3: a new site still defaults to active');

select lives_ok($$ update sites set status = 'paused' where name = 'Contacts site' $$,
  'item 4: status can be set to paused');
select lives_ok($$ update sites set status = 'completed' where name = 'Contacts site' $$,
  'item 5: status can be set to completed');
select lives_ok($$ update sites set status = 'archived' where name = 'Contacts site' $$,
  'item 6: status can be set to archived');
select throws_ok($$ update sites set status = 'demolished' where name = 'Contacts site' $$,
  '23514', null,
  'item 7: an unknown status value is rejected by the CHECK constraint');

-- The old site_status enum type is intentionally left in place, unused.
select ok(
  exists(select 1 from pg_type where typname = 'site_status'),
  'item 8: the now-unused site_status enum type is left in place (not dropped)'
);

select finish();
rollback;
