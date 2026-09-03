-- Migration 0023 hardening pass — proof that a SUSPENDED non-creator
-- granted owner cannot exercise any owner-only power.
--
-- Root fix (0023 section 4a): has_owner_grant() now returns false while
-- the holder's community_memberships.status is anything other than
-- 'approved'. Since every owner-authorization path funnels through
-- is_owner() -> has_owner_grant(), this file exercises a representative
-- spread of those paths (RLS policies AND SECURITY DEFINER RPCs) with a
-- granted owner who has been suspended, and proves:
--   * suspended granted owner: is_owner / is_approved_member / has_owner_grant all false
--   * every representative owner-only action is refused
--   * restore -> 'approved' reactivates all of it automatically
--   * the company creator is completely unaffected throughout
--   * an ordinary approved granted owner still works (baseline items)
begin;
select plan(34);

select tests.create_user('so-creator@test.local', 'SO Creator')  as creator \gset
select tests.create_user('so-gowner@test.local',  'SO GOwner')   as gowner \gset
select tests.create_user('so-worker@test.local',  'SO Worker')   as worker \gset
select tests.create_user('so-buyer@test.local',   'SO Buyer')    as buyer \gset
select tests.create_user('so-appl@test.local',    'SO Applicant') as appl \gset
select tests.create_user('so-appl2@test.local',   'SO Applicant Two') as appl2 \gset

select tests.authenticate_as(:'creator');
insert into communities (name, invite_code, owner_id) values ('SO Co', 'SOCO01', :'creator') returning id as co \gset
insert into sites (community_id, name, created_by_id) values (:'co', 'SO Site', :'creator') returning id as site \gset

select tests.authenticate_as(:'gowner');
insert into community_memberships (community_id, user_id, status) values (:'co', :'gowner', 'pending') returning id as m_gowner \gset
select tests.set_membership_status(:'co', :'gowner', 'approved', :'creator');
select tests.authenticate_as(:'worker');
insert into community_memberships (community_id, user_id, status) values (:'co', :'worker', 'pending') returning id as m_worker \gset
select tests.set_membership_status(:'co', :'worker', 'approved', :'creator');
select tests.authenticate_as(:'buyer');
insert into community_memberships (community_id, user_id, status) values (:'co', :'buyer', 'pending') returning id as m_buyer \gset
select tests.set_membership_status(:'co', :'buyer', 'approved', :'creator');
select tests.authenticate_as(:'appl');
insert into community_memberships (community_id, user_id, status) values (:'co', :'appl', 'pending') returning id as m_appl \gset
select tests.authenticate_as(:'appl2');
insert into community_memberships (community_id, user_id, status) values (:'co', :'appl2', 'pending') returning id as m_appl2 \gset

select tests.authenticate_as(:'creator');
insert into owner_grants (community_id, user_id, granted_by_id) values (:'co', :'gowner', :'creator');
insert into buyer_grants (community_id, user_id, granted_by_id) values (:'co', :'buyer', :'creator');
insert into site_memberships (site_id, community_id, user_id, added_by_id) values (:'site', :'co', :'worker', :'creator');

-- The order is created through the real create_order RPC by the worker
-- (approved member + site member) — orders has no direct INSERT grant.
-- require_owner_approval defaults true, so it lands in pending_approval.
select tests.authenticate_as(:'worker');
select create_order(:'co', :'site', 'p1', 'Test Product', '25kg', 5, 'each', 'AA1 1AA', null, null, 'b1', 'Merchant', 'merchant.co.uk', 'AA1 1AA', 'today', 6.75, null, null) as order_row \gset
select tests.authenticate_as(:'creator');
select id as order_id from orders where community_id = :'co' limit 1 \gset

-- ================================================================
-- BASELINE — the granted owner works normally while 'approved'
-- ================================================================
select ok(is_owner(:'co', :'gowner'),            'item 1: approved granted owner -> is_owner true');
select ok(is_approved_member(:'co', :'gowner'),  'item 2: approved granted owner -> is_approved_member true');
select ok(has_owner_grant(:'co', :'gowner'),     'item 3: approved granted owner -> has_owner_grant true');

-- ================================================================
-- SUSPEND the granted owner (by the creator)
-- ================================================================
select tests.authenticate_as(:'creator');
select suspend_member(:'m_gowner', 'authorization test');

select ok(not is_owner(:'co', :'gowner'),           'item 4: suspended granted owner -> is_owner FALSE');
select ok(not is_approved_member(:'co', :'gowner'), 'item 5: suspended granted owner -> is_approved_member FALSE');
select ok(not has_owner_grant(:'co', :'gowner'),    'item 6: suspended granted owner -> has_owner_grant FALSE');
select ok(exists(select 1 from owner_grants where community_id = :'co' and user_id = :'gowner'),
  'item 7: the owner_grants row is still physically present (dormant, not deleted)');

-- ---- suspended granted owner cannot exercise owner powers ----
select tests.authenticate_as(:'gowner');

select throws_ok(format($$ select decide_join_request(%L, 'approved') $$, :'m_appl'), '42501', null,
  'item 8: suspended owner cannot decide_join_request');
select throws_ok(format($$ select suspend_member(%L) $$, :'m_worker'), '42501', null,
  'item 9: suspended owner cannot suspend_member');
select throws_ok(format($$ select remove_member(%L) $$, :'m_worker'), '42501', null,
  'item 10: suspended owner cannot remove_member');
select throws_ok(format($$ select restore_member(%L) $$, :'m_gowner'), '42501', null,
  'item 11: suspended owner cannot restore_member (incl. themselves)');
select throws_ok(format($$ select revoke_buyer_access(%L, %L) $$, :'co', :'buyer'), '42501', null,
  'item 12: suspended owner cannot revoke_buyer_access');
select throws_ok(format($$ select remove_site_member(%L, %L) $$, :'site', :'worker'), '42501', null,
  'item 13: suspended owner cannot remove_site_member');
select throws_ok(format($$ select approve_order(%L) $$, :'order_id'), '42501', null,
  'item 14: suspended owner cannot approve_order');
select throws_ok(format($$ select reject_order(%L, 'no') $$, :'order_id'), '42501', null,
  'item 15: suspended owner cannot reject_order');

-- ---- RLS-gated direct writes: INSERT -> policy violation (42501),
-- ---- UPDATE/DELETE -> silently affects 0 rows ----
select throws_ok(
  format($$ insert into buyer_grants (community_id, user_id, granted_by_id) values (%L, %L, %L) $$, :'co', :'worker', :'gowner'),
  '42501', null, 'item 16: suspended owner cannot INSERT a buyer_grant (RLS)');
select throws_ok(
  format($$ insert into site_memberships (site_id, community_id, user_id, added_by_id) values (%L, %L, %L, %L) $$, :'site', :'co', :'buyer', :'gowner'),
  '42501', null, 'item 17: suspended owner cannot INSERT a site_membership (RLS)');
select throws_ok(
  format($$ insert into sites (community_id, name, created_by_id) values (%L, 'Sneaky Site', %L) $$, :'co', :'gowner'),
  '42501', null, 'item 18: suspended owner cannot INSERT a site (RLS)');

with u as (update communities set require_owner_approval = false where id = :'co' returning 1)
  select count(*)::int as n_settings from u \gset
select is(:'n_settings'::int, 0, 'item 19: suspended owner UPDATE of company settings affects 0 rows (RLS)');
with u as (update sites set name = 'Renamed' where id = :'site' returning 1)
  select count(*)::int as n_site from u \gset
select is(:'n_site'::int, 0, 'item 20: suspended owner UPDATE of a site affects 0 rows (RLS)');
with d as (delete from site_memberships where community_id = :'co' and user_id = :'worker' returning 1)
  select count(*)::int as n_sm from d \gset
select is(:'n_sm'::int, 0, 'item 21: suspended owner DELETE of a site membership affects 0 rows (RLS)');
with d as (delete from buyer_grants where community_id = :'co' and user_id = :'buyer' returning 1)
  select count(*)::int as n_bg from d \gset
select is(:'n_bg'::int, 0, 'item 22: suspended owner DELETE of a buyer grant affects 0 rows (RLS)');

-- confirm nothing above actually changed
select tests.authenticate_as(:'creator');
select is((select require_owner_approval from communities where id = :'co'), true, 'item 23: company setting unchanged');
select is((select name from sites where id = :'site'), 'SO Site', 'item 24: site name unchanged');
select is((select count(*) from site_memberships where community_id = :'co' and user_id = :'worker')::int, 1, 'item 25: worker still a site member');
select is((select status from community_memberships where id = :'m_appl'), 'pending', 'item 26: applicant still pending (no decision landed)');
select is((select status from orders where id = :'order_id')::text, 'pending_approval', 'item 27: order still pending_approval');

-- ================================================================
-- CREATOR is unaffected the whole time
-- ================================================================
select ok(is_owner(:'co', :'creator'), 'item 28: creator is_owner throughout');
select is((decide_join_request(:'m_appl', 'declined')).status, 'declined', 'item 29: creator can still decide_join_request while a granted owner is suspended');

-- ================================================================
-- RESTORE -> the dormant grant reactivates automatically
-- ================================================================
select restore_member(:'m_gowner');
select ok(is_owner(:'co', :'gowner'),           'item 30: restored granted owner -> is_owner true again');
select ok(is_approved_member(:'co', :'gowner'), 'item 31: restored granted owner -> is_approved_member true again');
select ok(has_owner_grant(:'co', :'gowner'),    'item 32: restored granted owner -> has_owner_grant true again (grant never re-created)');

select tests.authenticate_as(:'gowner');
select is((decide_join_request(:'m_appl2', 'approved')).status, 'approved',
  'item 33: the restored granted owner can decide_join_request again (permissions genuinely reactivated)');
with u as (update sites set name = 'Restored Rename' where id = :'site' returning 1)
  select count(*)::int as n_restored from u \gset
select is(:'n_restored'::int, 1, 'item 34: the restored granted owner can mutate a site again (RLS re-permits)');

select finish();
rollback;
