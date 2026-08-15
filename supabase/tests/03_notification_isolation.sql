-- Covers audit item 19. No RPC writes notifications yet in Phase 8A (that's
-- Phase 8D) — this exercises the RLS policy directly against manually
-- inserted rows, which is exactly what the eventual notification-creating
-- functions will rely on.
begin;
select plan(4);

select tests.create_user('owner-d@test.local', 'Owner D')     as owner_d \gset
select tests.create_user('recipient@test.local', 'Recipient') as recipient \gset
select tests.create_user('bystander@test.local', 'Bystander') as bystander \gset

-- Both inserted BEFORE the first tests.authenticate_as() call, i.e. while
-- this session is still the raw connecting superuser (which bypasses RLS
-- entirely) — standing in for the future SECURITY DEFINER writer function
-- Phase 8D will add for notifications. (An earlier version of this fixture
-- authenticated as owner_d first, which correctly hit "permission denied
-- for table notifications" once running as plain `authenticated` — there
-- is deliberately no INSERT policy for that role at all yet; see 0009.)
insert into communities (name, invite_code, owner_id) values ('Company D', 'DDDDDD', :'owner_d') returning id as company_d \gset
insert into notifications (recipient_user_id, type, category, title, message, community_id)
values (:'recipient', 'order_awaiting_approval', 'approvalUpdates', 'New order needs approval', 'test message', :'company_d');

select tests.authenticate_as(:'recipient');
select is( (select count(*) from notifications where recipient_user_id = :'recipient')::int, 1,
  'the real recipient can see their own notification (item 19)' );

select tests.authenticate_as(:'bystander');
select is( (select count(*) from notifications)::int, 0,
  'a different authenticated user sees zero notifications belonging to someone else (item 19)' );

select tests.authenticate_as(:'recipient');
update notifications set read = true where recipient_user_id = :'recipient';
select is( (select read from notifications where recipient_user_id = :'recipient'), true,
  'a recipient can mark their own notification read' );

select tests.authenticate_as(:'bystander');
-- A data-modifying WITH must be a top-level statement, not nested inside
-- another function call's argument list — hence the separate \gset step.
with attempt as (
  update notifications set read = false where recipient_user_id = :'recipient' returning 1
) select count(*)::int as attempt_rowcount from attempt \gset
select is( :'attempt_rowcount'::int, 0,
  'a different user''s UPDATE against another recipient''s notification affects zero rows (RLS using-clause blocks it entirely)'
);

select finish();
rollback;
