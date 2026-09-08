-- Local dev seed data. Runs automatically after `supabase db reset` (and is
-- ignored by `db push` / hosted). Purely for local click-testing - every
-- account is demo-*@test.local with the same throwaway password.
--
-- Login for all five: password  demopass123
--
--   demo-owner@test.local    Olivia Ostrowski  - creator/owner of Redbridge
--   demo-owner2@test.local   Owen Bright       - granted owner
--   demo-worker@test.local   Wesley Cole       - approved worker, on Site A
--   demo-buyer@test.local    Priya Nair        - approved + buyer grant, Site A
--   demo-driver@test.local   Dan Rutherford    - approved driver

do $$
declare
  v_owner  uuid := 'd0000000-0000-0000-0000-000000000001';
  v_owner2 uuid := 'd0000000-0000-0000-0000-000000000002';
  v_worker uuid := 'd0000000-0000-0000-0000-000000000003';
  v_buyer  uuid := 'd0000000-0000-0000-0000-000000000004';
  v_driver uuid := 'd0000000-0000-0000-0000-000000000005';
  v_co     uuid := 'd0000000-0000-0000-0000-0000000000c1';
  v_site   uuid := 'd0000000-0000-0000-0000-000000000551';
  v_pw     text := crypt('demopass123', gen_salt('bf'));
  r record;
begin
  if exists (select 1 from auth.users where id = v_owner) then return; end if;

  for r in
    select * from (values
      (v_owner,  'demo-owner@test.local',   'Olivia Ostrowski'),
      (v_owner2, 'demo-owner2@test.local',  'Owen Bright'),
      (v_worker, 'demo-worker@test.local',  'Wesley Cole'),
      (v_buyer,  'demo-buyer@test.local',   'Priya Nair'),
      (v_driver, 'demo-driver@test.local',  'Dan Rutherford')
    ) as t(id, email, name)
  loop
    insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at,
                            created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
    values (r.id, 'authenticated', 'authenticated', r.email, v_pw, now(), now(), now(),
            '{"provider":"email","providers":["email"]}',
            jsonb_build_object('display_name', r.name));
    -- profiles row is made by the 0002 trigger; make sure the name matches
    update profiles set display_name = r.name where id = r.id;
  end loop;

  insert into communities (id, name, invite_code, owner_id, require_owner_approval, discoverable)
  values (v_co, 'Redbridge Construction', 'RDBRDG', v_owner, true, false);

  insert into community_memberships (community_id, user_id, status, decided_at, decided_by_id) values
    (v_co, v_owner,  'approved', now(), v_owner),
    (v_co, v_owner2, 'approved', now(), v_owner),
    (v_co, v_worker, 'approved', now(), v_owner),
    (v_co, v_buyer,  'approved', now(), v_owner),
    (v_co, v_driver, 'approved', now(), v_owner);

  insert into owner_grants (community_id, user_id, granted_by_id) values (v_co, v_owner2, v_owner);
  insert into buyer_grants (community_id, user_id, granted_by_id) values (v_co, v_buyer,  v_owner);

  insert into sites (id, community_id, name, address, postcode, delivery_instructions, status, created_by_id)
  values (v_site, v_co, 'Site A - Riverside', '1 Riverside Way', 'N1 7GR', 'Gate code 4821', 'active', v_owner);
  insert into site_memberships (site_id, community_id, user_id, added_by_id) values
    (v_site, v_co, v_worker, v_owner),
    (v_site, v_co, v_buyer,  v_owner);

  -- one order awaiting approval, one already delivered
  insert into orders (id, community_id, site_id, site_name, site_postcode, product_name, variant,
                      delivery_postcode, requested_by_id, requested_by, status, approval_was_required,
                      needed_by_type, needed_by, approved_by_id, approved_by, driver_id, driver,
                      delivery_time, delivery_location)
  values
    ('d0000000-0000-0000-0000-00000000a001', v_co, v_site, 'Site A - Riverside', 'N1 7GR',
     'General Purpose Cement', '25kg bag', 'N1 7GR', v_worker, 'Wesley Cole', 'pending_approval', true,
     'asap', null, null, null, null, null, null, null),
    ('d0000000-0000-0000-0000-00000000a002', v_co, v_site, 'Site A - Riverside', 'N1 7GR',
     'Timber CLS', '38x63mm 2.4m', 'N1 7GR', v_worker, 'Wesley Cole', 'delivered', true,
     'deadline', now() + interval '2 days', v_owner, 'Olivia Ostrowski', v_driver, 'Dan Rutherford',
     now() - interval '1 hour', 'Site A - Riverside');

  insert into order_items (order_id, community_id, product_id, product_name, variant, quantity, unit, line_total, sort_order) values
    ('d0000000-0000-0000-0000-00000000a001', v_co, 'p1', 'General Purpose Cement', '25kg bag', 10, 'bag', 0, 0),
    ('d0000000-0000-0000-0000-00000000a002', v_co, 'p2', 'Timber CLS', '38x63mm 2.4m', 24, 'length', 0, 0);

  insert into order_events (order_id, community_id, type, actor_id, actor_name, to_status) values
    ('d0000000-0000-0000-0000-00000000a001', v_co, 'order_created', v_worker, 'Wesley Cole', 'pending_approval'),
    ('d0000000-0000-0000-0000-00000000a002', v_co, 'order_created', v_worker, 'Wesley Cole', 'pending_approval'),
    ('d0000000-0000-0000-0000-00000000a002', v_co, 'delivered',     v_driver, 'Dan Rutherford', 'delivered');
end $$;
