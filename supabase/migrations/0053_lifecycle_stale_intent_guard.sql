-- Stale-intent guard on the 5 Company Workforce Lifecycle RPCs — the
-- hardening pass flagged (and deliberately deferred) since migration 0023,
-- see PROGRESS.md's "Known issues / rough edges" entry for the full
-- incident this closes.
--
-- THE INCIDENT, IN ONE LINE: during 0023 Phase C's live production QA, a
-- rerequest_membership call timed out client-side, then executed for real
-- ~90 MINUTES later — the instant an unrelated transaction released the
-- same row's lock — using its original, by-then-completely-stale input,
-- and silently changed the row from 'left' back to 'pending'.
--
-- WHY THE EXISTING GUARDS DIDN'T CATCH IT: every one of these RPCs already
-- does `where status = <expected>` + a 40001 on mismatch (the same
-- discipline as every order-lifecycle RPC) — but that only protects
-- against the ROW having changed. It says nothing about the REQUEST itself
-- having gone stale. In the incident, the row's state at execution time
-- genuinely did match what the guard required (status = 'left', a legal
-- source for rerequest_membership) — the RPC behaved exactly as designed
-- against the state it actually observed. The bug was that "the state it
-- observed" was current in a request queued ~90 minutes earlier reaching
-- Postgres 90 minutes late, not that the guard logic was wrong.
--
-- WHAT WAS ALREADY RULED OUT (migration 0024's investigation, see its own
-- header + PROGRESS.md): a plain Postgres row-lock wait is bounded to ~8s
-- by Supabase's own platform-level statement_timeout/lock_timeout on the
-- authenticator role (live-verified with a genuine two-connection lock
-- contention test) — so that was never the true 90-minute mechanism. The
-- far more likely cause sits BELOW Postgres entirely: the connection
-- pooler (Supavisor) queuing a request while waiting for a free backend
-- connection, before any SQL statement — and therefore before any
-- statement_timeout, existing or new — ever starts running. No SQL-level
-- timeout can bound that layer; closing it fully needs a pooler/PostgREST
-- setting (pool size, a db-pool-acquisition-timeout) configured via the
-- Supabase project dashboard, which is genuinely outside what a migration
-- can reach. THIS MIGRATION DOES NOT CLOSE THAT — it closes the part that
-- actually is reachable from SQL: making a request refuse itself once it's
-- unambiguously too old to still represent the caller's real intent,
-- regardless of which layer caused the delay.
--
-- THE FIX: each of the 5 RPCs gains one new, optional trailing parameter,
-- p_client_issued_at timestamptz. The client captures its own clock the
-- instant the user's action is issued (before the network call starts) and
-- passes it straight through. The RPC's very first action — before it
-- even acquires a row lock, so a stale call has zero side effects, not
-- even a lock wait — is to refuse outright if now() - p_client_issued_at
-- exceeds a threshold. 60 seconds is deliberately generous (matching this
-- schema's existing "thresholds stop a script/anomaly, not a real slow
-- human" philosophy — see 0050's own header): no genuine user interaction,
-- however slow their connection, plausibly takes over a minute between
-- tapping a button and the request reaching the server, but 90 minutes
-- obviously does not belong in that window either. The parameter defaults
-- to NULL and is skipped entirely when NULL (so a pgTAP test or any other
-- direct-SQL caller that doesn't pass it behaves exactly as before) — only
-- the real app's own call sites (public/js/community.js) are expected to
-- always supply it going forward.
--
-- Custom errcode 'STALE' (not a real Postgres/PostgREST-reserved code, no
-- collision risk) — deliberately distinct from 40001 (stale ROW version)
-- so the client can tell "your request itself arrived too late, just
-- retry" apart from "the row changed under you, refresh and look again".
--
-- Scope: exactly the 5 RPCs the original incident and its own deferred
-- follow-up named — suspend_member / restore_member / remove_member /
-- leave_community / rerequest_membership. request_join_by_invite_code and
-- decide_join_request were not implicated and are left untouched; broaden
-- this pattern to them only if a similar incident is ever actually
-- observed there, not preemptively.

drop function if exists suspend_member(uuid, text);
drop function if exists restore_member(uuid);
drop function if exists remove_member(uuid, text);
drop function if exists leave_community(uuid);
drop function if exists rerequest_membership(uuid);

create function suspend_member(p_membership_id uuid, p_reason text default null, p_client_issued_at timestamptz default null)
returns community_memberships
language plpgsql security definer set search_path = public as $$
declare
  v_m community_memberships%rowtype;
  v_target_is_owner boolean;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if p_client_issued_at is not null and now() - p_client_issued_at > interval '60 seconds' then
    raise exception 'this request took too long to reach the server and may be based on outdated information - please try again' using errcode = 'STALE';
  end if;

  select * into v_m from community_memberships where id = p_membership_id for update;
  if not found then raise exception 'membership not found' using errcode = '42704'; end if;

  if not is_owner(v_m.community_id, auth.uid()) then
    raise exception 'only an owner may suspend a member' using errcode = '42501';
  end if;
  if v_m.user_id = auth.uid() then
    raise exception 'you cannot suspend yourself' using errcode = '42501';
  end if;
  if is_creator(v_m.community_id, v_m.user_id) then
    raise exception 'the company creator cannot be suspended' using errcode = '42501';
  end if;
  v_target_is_owner := exists (select 1 from owner_grants where community_id = v_m.community_id and user_id = v_m.user_id);
  if v_target_is_owner and not is_creator(v_m.community_id, auth.uid()) then
    raise exception 'only the company creator may suspend another owner' using errcode = '42501';
  end if;

  update community_memberships set
    status = 'suspended',
    status_changed_at = now(),
    status_changed_by_id = auth.uid(),
    status_reason = p_reason
  where id = p_membership_id and status = 'approved'
  returning * into v_m;
  if not found then raise exception 'member is not in an approved state' using errcode = '40001'; end if;

  perform _log_membership_event(v_m.id, v_m.community_id, 'member_suspended', 'approved', 'suspended', p_reason, null);

  insert into notifications (recipient_user_id, type, category, title, message, community_id, actor_id, actor_name, navigation_target)
  select v_m.user_id, 'membership_suspended', 'roleUpdates', 'Access suspended',
    format('Your access to %s has been suspended.%s',
      (select name from communities where id = v_m.community_id),
      case when p_reason is not null and btrim(p_reason) <> '' then E'\nReason: ' || btrim(p_reason) else '' end),
    v_m.community_id, auth.uid(), coalesce(nullif(_current_display_name(), ''), 'An owner'),
    jsonb_build_object('communityId', v_m.community_id, 'view', 'profile')
  where v_m.user_id is distinct from auth.uid();

  return v_m;
end;
$$;

create function restore_member(p_membership_id uuid, p_client_issued_at timestamptz default null)
returns community_memberships
language plpgsql security definer set search_path = public as $$
declare
  v_m community_memberships%rowtype;
  v_from text;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if p_client_issued_at is not null and now() - p_client_issued_at > interval '60 seconds' then
    raise exception 'this request took too long to reach the server and may be based on outdated information - please try again' using errcode = 'STALE';
  end if;

  select * into v_m from community_memberships where id = p_membership_id for update;
  if not found then raise exception 'membership not found' using errcode = '42704'; end if;
  if not is_owner(v_m.community_id, auth.uid()) then
    raise exception 'only an owner may restore a member' using errcode = '42501';
  end if;

  v_from := v_m.status;
  update community_memberships set
    status = 'approved',
    status_changed_at = now(),
    status_changed_by_id = auth.uid(),
    status_reason = null
  where id = p_membership_id and status in ('suspended', 'removed')
  returning * into v_m;
  if not found then raise exception 'member is not suspended or removed' using errcode = '40001'; end if;

  perform _log_membership_event(v_m.id, v_m.community_id, 'member_restored', v_from, 'approved', null, null);

  insert into notifications (recipient_user_id, type, category, title, message, community_id, actor_id, actor_name, navigation_target)
  select v_m.user_id, 'membership_restored', 'roleUpdates', 'Access restored',
    format('Your access to %s has been restored.', (select name from communities where id = v_m.community_id)),
    v_m.community_id, auth.uid(), coalesce(nullif(_current_display_name(), ''), 'An owner'),
    jsonb_build_object('communityId', v_m.community_id, 'role', 'worker')
  where v_m.user_id is distinct from auth.uid();

  return v_m;
end;
$$;

create function remove_member(p_membership_id uuid, p_reason text default null, p_client_issued_at timestamptz default null)
returns community_memberships
language plpgsql security definer set search_path = public as $$
declare
  v_m community_memberships%rowtype;
  v_from text;
  v_target_is_owner boolean;
  v_sites_removed int;
  v_had_owner_grant boolean;
  v_had_buyer_grant boolean;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if p_client_issued_at is not null and now() - p_client_issued_at > interval '60 seconds' then
    raise exception 'this request took too long to reach the server and may be based on outdated information - please try again' using errcode = 'STALE';
  end if;

  select * into v_m from community_memberships where id = p_membership_id for update;
  if not found then raise exception 'membership not found' using errcode = '42704'; end if;

  if not is_owner(v_m.community_id, auth.uid()) then
    raise exception 'only an owner may remove a member' using errcode = '42501';
  end if;
  if v_m.user_id = auth.uid() then
    raise exception 'you cannot remove yourself — use leave instead' using errcode = '42501';
  end if;
  if is_creator(v_m.community_id, v_m.user_id) then
    raise exception 'the company creator cannot be removed' using errcode = '42501';
  end if;
  v_target_is_owner := exists (select 1 from owner_grants where community_id = v_m.community_id and user_id = v_m.user_id);
  if v_target_is_owner and not is_creator(v_m.community_id, auth.uid()) then
    raise exception 'only the company creator may remove another owner' using errcode = '42501';
  end if;

  v_from := v_m.status;

  update community_memberships set
    status = 'removed',
    status_changed_at = now(),
    status_changed_by_id = auth.uid(),
    status_reason = p_reason
  where id = p_membership_id and status in ('approved', 'suspended')
  returning * into v_m;
  if not found then raise exception 'member is not active or suspended' using errcode = '40001'; end if;

  v_had_owner_grant := exists (select 1 from owner_grants where community_id = v_m.community_id and user_id = v_m.user_id);
  v_had_buyer_grant := exists (select 1 from buyer_grants where community_id = v_m.community_id and user_id = v_m.user_id);
  delete from owner_grants where community_id = v_m.community_id and user_id = v_m.user_id;
  delete from buyer_grants where community_id = v_m.community_id and user_id = v_m.user_id;
  delete from site_memberships where community_id = v_m.community_id and user_id = v_m.user_id;
  get diagnostics v_sites_removed = row_count;
  delete from buyer_requests where community_id = v_m.community_id and user_id = v_m.user_id;

  perform _log_membership_event(
    v_m.id, v_m.community_id, 'member_removed', v_from, 'removed', p_reason,
    jsonb_build_object('ownerGrantRevoked', v_had_owner_grant, 'buyerGrantRevoked', v_had_buyer_grant, 'siteMembershipsRemoved', v_sites_removed)
  );

  insert into notifications (recipient_user_id, type, category, title, message, community_id, actor_id, actor_name, navigation_target)
  select v_m.user_id, 'membership_removed', 'roleUpdates', 'Removed from company',
    format('You have been removed from %s.%s',
      (select name from communities where id = v_m.community_id),
      case when p_reason is not null and btrim(p_reason) <> '' then E'\nReason: ' || btrim(p_reason) else '' end),
    v_m.community_id, auth.uid(), coalesce(nullif(_current_display_name(), ''), 'An owner'),
    jsonb_build_object('communityId', v_m.community_id, 'view', 'profile')
  where v_m.user_id is distinct from auth.uid();

  return v_m;
end;
$$;

create function leave_community(p_community_id uuid, p_client_issued_at timestamptz default null)
returns community_memberships
language plpgsql security definer set search_path = public as $$
declare
  v_m community_memberships%rowtype;
  v_actor_name text;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if p_client_issued_at is not null and now() - p_client_issued_at > interval '60 seconds' then
    raise exception 'this request took too long to reach the server and may be based on outdated information - please try again' using errcode = 'STALE';
  end if;
  if is_creator(p_community_id, auth.uid()) then
    raise exception 'the company creator cannot leave their own company' using errcode = '42501';
  end if;

  select * into v_m from community_memberships
  where community_id = p_community_id and user_id = auth.uid() for update;
  if not found then raise exception 'you are not a member of this company' using errcode = '42704'; end if;

  update community_memberships set
    status = 'left',
    status_changed_at = now(),
    status_changed_by_id = auth.uid(),
    status_reason = null
  where id = v_m.id and status = 'approved'
  returning * into v_m;
  if not found then raise exception 'you are not an active member' using errcode = '40001'; end if;

  delete from owner_grants where community_id = p_community_id and user_id = auth.uid();
  delete from buyer_grants where community_id = p_community_id and user_id = auth.uid();
  delete from site_memberships where community_id = p_community_id and user_id = auth.uid();
  delete from buyer_requests where community_id = p_community_id and user_id = auth.uid();

  perform _log_membership_event(v_m.id, p_community_id, 'member_left', 'approved', 'left', null, null);

  v_actor_name := coalesce(nullif(_current_display_name(), ''), 'A member');
  insert into notifications (recipient_user_id, type, category, title, message, community_id, actor_id, actor_name, navigation_target)
  select uid, 'member_left', 'roleUpdates', 'A member left',
    format('%s left %s.', v_actor_name, (select name from communities where id = p_community_id)),
    p_community_id, auth.uid(), v_actor_name,
    jsonb_build_object('communityId', p_community_id, 'role', 'owner')
  from (
    select owner_id as uid from communities where id = p_community_id
    union select user_id from owner_grants where community_id = p_community_id
  ) owners
  where uid is distinct from auth.uid() and notification_type_enabled_for(uid, 'member_left');

  return v_m;
end;
$$;

create function rerequest_membership(p_community_id uuid, p_client_issued_at timestamptz default null)
returns community_memberships
language plpgsql security definer set search_path = public as $$
declare
  v_m community_memberships%rowtype;
  v_from text;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if p_client_issued_at is not null and now() - p_client_issued_at > interval '60 seconds' then
    raise exception 'this request took too long to reach the server and may be based on outdated information - please try again' using errcode = 'STALE';
  end if;

  select * into v_m from community_memberships
  where community_id = p_community_id and user_id = auth.uid() for update;
  if not found then raise exception 'you have no prior membership record for this company' using errcode = '42704'; end if;

  v_from := v_m.status;
  update community_memberships set
    status = 'pending',
    requested_at = now(),
    decided_at = null,
    decided_by_id = null,
    status_changed_at = now(),
    status_changed_by_id = auth.uid(),
    status_reason = null
  where id = v_m.id and status in ('declined', 'left', 'removed')
  returning * into v_m;
  if not found then raise exception 'your membership is not in a re-requestable state' using errcode = '40001'; end if;

  perform _log_membership_event(v_m.id, p_community_id, 'member_rerequested', v_from, 'pending', null, null);
  return v_m;
end;
$$;

revoke execute on function suspend_member(uuid, text, timestamptz) from public, anon;
revoke execute on function restore_member(uuid, timestamptz) from public, anon;
revoke execute on function remove_member(uuid, text, timestamptz) from public, anon;
revoke execute on function leave_community(uuid, timestamptz) from public, anon;
revoke execute on function rerequest_membership(uuid, timestamptz) from public, anon;

grant execute on function suspend_member(uuid, text, timestamptz) to authenticated;
grant execute on function restore_member(uuid, timestamptz) to authenticated;
grant execute on function remove_member(uuid, text, timestamptz) to authenticated;
grant execute on function leave_community(uuid, timestamptz) to authenticated;
grant execute on function rerequest_membership(uuid, timestamptz) to authenticated;
