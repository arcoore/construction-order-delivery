-- Server-side 2FA enforcement (migration 0040). The mfa_aal2_guard trigger
-- refuses a write when the caller has a verified MFA factor but the request
-- is still aal1; a caller with no factor is completely unaffected.
begin;
select plan(6);

select tests.create_user('mfa-none@test.local', 'No MFA') as u_none \gset
select tests.create_user('mfa-on@test.local', 'Has MFA')  as u_mfa \gset

-- give u_mfa a verified TOTP factor directly (Supabase's own table)
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret)
values (gen_random_uuid(), :'u_mfa', 'test-factor', 'totp', 'verified', now(), now(), 'SECRET');

insert into communities (name, invite_code, owner_id) values ('MFA Base Co', 'MFABAS', :'u_none') returning id as co \gset
-- a company the 2FA user owns, so its RLS UPDATE policy lets the row match
-- and the trigger is what actually refuses (not RLS filtering it out first).
insert into communities (name, invite_code, owner_id) values ('MFA Owner Co', 'MFAOWN', :'u_mfa');

-- item 1: a user with NO factor writes normally (authenticate_as sets no aal claim)
select tests.authenticate_as(:'u_none');
select lives_ok(
  $$ update communities set name = 'MFA Base Co v2' where invite_code = 'MFABAS' $$,
  'item 1: a user without 2FA is completely unaffected by the guard'
);

-- item 2: the user WITH a verified factor, at aal1, is refused an INSERT
select tests.authenticate_as(:'u_mfa');
select throws_ok(
  format($$ insert into communities (name, invite_code, owner_id) values ('Sneaky Co', 'SNEAK1', %L) $$, :'u_mfa'),
  '42501', 'Finish two-factor sign-in before making this change.',
  'item 2: a 2FA user at aal1 cannot INSERT'
);

-- item 3: ...and cannot UPDATE a row they DO own (RLS lets it match; the
-- trigger is what refuses)
select throws_ok(
  $$ update communities set name = 'renamed' where invite_code = 'MFAOWN' $$,
  '42501', null,
  'item 3: a 2FA user at aal1 cannot UPDATE their own company'
);

-- item 4: ...and the guard covers child tables too (orders)
select throws_ok(
  format($$ insert into orders (community_id, site_id, site_name, product_name, delivery_postcode, requested_by_id, requested_by)
            values (%L, null, 'x', 'y', 'SW1A 1AA', %L, 'Has MFA') $$, :'co', :'u_mfa'),
  '42501', null,
  'item 4: the guard covers child tables (orders), not just communities'
);

-- item 5: the SAME user, once the request is aal2, writes fine
select set_config('request.jwt.claims',
  json_build_object('sub', :'u_mfa'::text, 'role', 'authenticated', 'aal', 'aal2')::text, true);
select lives_ok(
  format($$ insert into communities (name, invite_code, owner_id) values ('AAL2 Co', 'AAL2CO', %L) $$, :'u_mfa'),
  'item 5: the same 2FA user, at aal2, writes normally'
);

-- item 6: sanity — the aal2 write actually landed
select is(
  (select count(*) from communities where invite_code = 'AAL2CO')::int, 1,
  'item 6: the aal2 write landed'
);

select finish();
rollback;
