-- In-app feedback table (migration 0048): authenticated-only, insert-only,
-- service_role-read-only, per-user cooldown + global cap.
begin;
select plan(10);

select tests.create_user('fb-a@test.local', 'FB A') as a \gset
select tests.create_user('fb-b@test.local', 'FB B') as b \gset

-- ---- grants -------------------------------------------------------
select ok(not has_table_privilege('anon', 'public.feedback', 'INSERT'),
  'item 1: anon has NO insert on feedback (unlike client_errors)');
select ok(has_table_privilege('authenticated', 'public.feedback', 'INSERT'),
  'item 2: authenticated can insert');
select ok(not has_table_privilege('authenticated', 'public.feedback', 'SELECT'),
  'item 3: authenticated cannot select - service_role-read-only');

-- ---- happy path -------------------------------------------------
select tests.authenticate_as(:'a');
select lives_ok(
  $$ insert into feedback (message, context, path) values ('the site picker confused me', 'general', '/') $$,
  'item 4: an authenticated user can leave feedback');

-- ---- per-user cooldown ---------------------------------------
select throws_ok(
  $$ insert into feedback (message) values ('a second message, too soon') $$,
  '53400', 'feedback: please wait a few seconds between messages',
  'item 5: a second message from the same user inside 20s is refused');

reset role;
update feedback set created_at = created_at - interval '21 seconds';
select tests.authenticate_as(:'a');
select lives_ok(
  $$ insert into feedback (message, context) values ('all good now', 'milestone_first_delivery') $$,
  'item 6: once 20s has passed, the same user can post again');

-- ---- another user is unaffected -----------------------------
select tests.authenticate_as(:'b');
select lives_ok(
  $$ insert into feedback (message) values ('different person, same window') $$,
  'item 7: another user is not blocked by the first user''s cooldown');

-- Each remaining check starts from a clean table + a fresh user so the
-- per-user cooldown never masks the thing under test.
reset role; delete from feedback;
select tests.authenticate_as(:'b');
select throws_ok(
  format($$ insert into feedback (user_id, message) values (%L, 'forged') $$, :'a'),
  '42501', null,
  'item 8: cannot insert a row attributed to another user');

reset role; delete from feedback;
select tests.create_user('fb-c@test.local', 'FB C') as c \gset
select tests.authenticate_as(:'c');
select throws_ok(
  $$ insert into feedback (message) values ('   ') $$,
  '23514', null, 'item 9: a blank message is rejected by the length CHECK');

reset role; delete from feedback;
select tests.create_user('fb-d@test.local', 'FB D') as d \gset
select tests.authenticate_as(:'d');
select throws_ok(
  $$ insert into feedback (message, context) values ('hi', 'not-a-real-context') $$,
  '23514', null, 'item 10: an unknown context value is rejected by the CHECK');

select finish();
rollback;
