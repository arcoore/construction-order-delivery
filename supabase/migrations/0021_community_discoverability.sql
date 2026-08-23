-- Roadmap Step 5 — Company Setup & Onboarding: private-by-default community
-- discoverability. Closes the gap the launch-readiness audit found:
-- `communities_select_any` (0009) granted `for select to authenticated using
-- (true)` — every signed-up user on the platform could SELECT every
-- company's name + owner, and "Request to join" any of them, purely to
-- support the browse-by-name feature. Forward-only — 0009 is not edited.
--
-- PRODUCT DECISION (explicit, not assumed): existing communities become
-- discoverable = false immediately, not grandfathered as true. SiteStock has
-- no real customer companies relying on global browse yet, so privacy-by-
-- default applies to every row that exists today too, not just new ones —
-- this is why the new column is added as `not null default false` with no
-- follow-up UPDATE to restore any existing row to true. A plain ADD COLUMN
-- ... DEFAULT false backfills every existing row with false automatically;
-- no separate UPDATE statement is needed or wanted here.
--
-- `communities.invite_code` ALREADY has a real database-level UNIQUE
-- constraint — `invite_code text not null unique` was there from the very
-- first community migration (0003_communities_and_membership.sql:8). A
-- pre-implementation duplicate check against the live local database (both
-- test communities that exist there) found zero duplicates, so no data
-- cleanup was needed — but no new constraint is added here either, since one
-- already exists. This migration's own header documents that finding rather
-- than silently assuming it away.

alter table communities add column discoverable boolean not null default false;

-- ================================================================
-- communities SELECT policy — replace unconditional-open with scoped.
-- Four cases, matching the approved design exactly:
--   A. the community's owner (creator)                        -> owner_id = auth.uid()
--   A'. the community's owner (granted, not creator)           -> has_owner_grant
--   B. an approved member                                      -> EXISTS on community_memberships
--   C. a user with a real pending join request for this row    -> EXISTS on community_memberships
--   D. discoverable = true                                     -> plain column check
-- An unrelated authenticated user with none of A-D sees nothing for that
-- row. Anon has no SELECT policy on communities at all, before or after this
-- migration — unaffected, still zero rows.
--
-- DELIBERATELY NOT is_owner(id, auth.uid())/is_approved_member(id, auth.uid())
-- here, even though they're logically equivalent for cases A/A'/B — this is
-- the EXACT SAME self-reference bug class 0009's own sites_select comment
-- already documents and fixes for `sites`: is_owner internally calls
-- is_creator, which re-queries `communities` itself ("select exists(select 1
-- from communities where id = ... and owner_id = ...)"). On INSERT ...
-- RETURNING, Postgres evaluates this SELECT policy against the row the same
-- statement just wrote, and that self-referential re-query of `communities`
-- does not see its own not-yet-externally-visible row within the same
-- command — found live during this migration's own local verification: a
-- fresh community creation with RETURNING spuriously failed RLS even though
-- the INSERT's own WITH CHECK had already passed, exactly reproducing the
-- documented 0009 bug class one migration later, in a different table.
-- Testing the row's own owner_id column directly (no re-query of
-- communities) avoids it entirely, mirroring sites_select's own fix.
-- has_owner_grant/the two EXISTS clauses below query owner_grants/
-- community_memberships — different tables, no self-reference, safe.
-- ================================================================
drop policy communities_select_any on communities;

create policy communities_select_scoped on communities
  for select to authenticated
  using (
    discoverable = true
    or owner_id = auth.uid()
    or has_owner_grant(id, auth.uid())
    or exists (
      select 1 from community_memberships
      where community_id = communities.id
        and user_id = auth.uid()
        and status in ('approved', 'pending')
    )
  );

-- ================================================================
-- request_join_by_invite_code — the one new RPC this phase needs.
--
-- WHY THIS RPC EXISTS: the frontend's existing requestToJoinByCode
-- (community.js) resolved a code by scanning the already-fully-cached
-- client-side `cache.communities` array — which only worked because every
-- community was previously SELECTable by everyone. Once communities are
-- scoped (above), a private community's row is no longer in that cache for
-- someone who isn't already related to it, so a client-side code-to-id
-- lookup can no longer find it — and a SELECT policy shaped to "let an exact
-- invite_code match through" would be equivalent to letting a client
-- brute-force enumerate the whole table one guess at a time, which defeats
-- the point of scoping SELECT at all. This SECURITY DEFINER function is the
-- safe alternative: it resolves the code with elevated privilege, checks the
-- caller's own current relationship to that one community, and returns only
-- the minimum the frontend needs (status + the one matched community's id
-- and name) — never a list, never another user's data, never the row set.
--
-- IMPORTANT — mirrors requestToJoinByCode's EXISTING behavior exactly,
-- including its one pre-existing limitation: if ANY community_memberships
-- row already exists for (community, user) — including a 'declined' one —
-- this returns that row's current status without creating or changing
-- anything. That's not a new decision made here; it's the same behavior the
-- old client-side requestToJoin() already had (a declined user "re-
-- requesting" today silently keeps their old declined row, never getting a
-- fresh pending one) — out of scope for Step 5 to change, so it's preserved
-- byte-for-byte rather than quietly fixed as a side effect of this migration.
--
-- Never auto-approves: the only status this can ever WRITE is 'pending'.
-- Owner approval remains the only path to 'approved', completely untouched.
--
-- `justCreated` (found during this migration's own local live verification):
-- a freshly-inserted pending row and a pre-existing pending row both have
-- status = 'pending', with no other field distinguishing them — without
-- justCreated, the frontend (community.js's requestToJoinByCode) can't tell
-- "your request was just sent" from "you already had one," and a real live
-- test surfaced exactly that: a genuinely first-time joiner saw "Already
-- requested to join... waiting for approval" instead of "Request sent...".
-- justCreated is true only on the branch that just executed the INSERT.
-- ================================================================
create or replace function request_join_by_invite_code(p_code text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_community communities%rowtype;
  v_existing community_memberships%rowtype;
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select * into v_community from communities
  where invite_code = upper(trim(p_code));

  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  if is_owner(v_community.id, v_user_id) then
    return jsonb_build_object(
      'ok', true, 'status', 'owner', 'justCreated', false,
      'communityId', v_community.id, 'communityName', v_community.name
    );
  end if;

  select * into v_existing from community_memberships
  where community_id = v_community.id and user_id = v_user_id;

  if found then
    return jsonb_build_object(
      'ok', true, 'status', v_existing.status, 'justCreated', false,
      'communityId', v_community.id, 'communityName', v_community.name
    );
  end if;

  insert into community_memberships (community_id, user_id, status)
  values (v_community.id, v_user_id, 'pending');

  return jsonb_build_object(
    'ok', true, 'status', 'pending', 'justCreated', true,
    'communityId', v_community.id, 'communityName', v_community.name
  );
end;
$$;

revoke execute on function request_join_by_invite_code(text) from public, anon;
grant execute on function request_join_by_invite_code(text) to authenticated;

-- No Realtime publication change — `communities` is already published
-- (0016_realtime_publication.sql); the new column and the narrowed policy
-- ride along automatically, no publication edit needed. No change to
-- community_memberships/owner_grants/buyer_grants/buyer_requests/sites/
-- site_memberships RLS, grants, or any order-lifecycle/notification/product/
-- supplier object — this migration touches exactly the communities table's
-- schema+policy and adds exactly one new narrow RPC, nothing else.
