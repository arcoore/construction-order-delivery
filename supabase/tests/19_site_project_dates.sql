-- Site project dates (migration 0025) — purely additive nullable columns
-- plus one CHECK constraint (end date can never precede start date).
begin;
select plan(6);

select tests.create_user('owner-pd@test.local', 'Owner PD') as owner_pd \gset
insert into communities (name, invite_code, owner_id) values ('PD Co', 'PDCO01', :'owner_pd') returning id as co \gset

select tests.authenticate_as(:'owner_pd');

select lives_ok(
  format($$ insert into sites (community_id, name, created_by_id) values (%L, 'No dates site', %L) $$, :'co', :'owner_pd'),
  'item 1: a site with no project dates set (both NULL) remains valid — the pre-existing default behavior'
);

select lives_ok(
  format($$ insert into sites (community_id, name, created_by_id, project_start_date, project_end_date) values (%L, 'Dated site', %L, current_date, current_date + 30) $$, :'co', :'owner_pd'),
  'item 2: a site with a valid start/end date range is accepted'
);

select lives_ok(
  format($$ insert into sites (community_id, name, created_by_id, project_start_date) values (%L, 'Start only site', %L, current_date) $$, :'co', :'owner_pd'),
  'item 3: a site with only a start date (no end date yet) is valid — an ongoing project'
);

select throws_ok(
  format($$ insert into sites (community_id, name, created_by_id, project_start_date, project_end_date) values (%L, 'Bad range site', %L, current_date, current_date - 1) $$, :'co', :'owner_pd'),
  '23514', null,
  'item 4: an end date before the start date is rejected by the CHECK constraint'
);

select id as site_id from sites where name = 'Dated site' and community_id = :'co' \gset
update sites set project_end_date = current_date + 60 where id = :'site_id';
select ok(
  (select project_end_date = current_date + 60 from sites where id = :'site_id'),
  'item 5: an existing site''s end date can be updated (extending a project)'
);

select ok(
  (select project_start_date is null and project_end_date is null from sites where name = 'No dates site' and community_id = :'co'),
  'item 6: a site created before this migration-shaped concept existed (or simply without dates) reads back honestly NULL, never fabricated'
);

select finish();
rollback;
