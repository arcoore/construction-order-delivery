// Phase 8D.2 — Supabase Realtime as a pure FRESHNESS SIGNAL layer on top of
// the existing cache architecture (community.js/sites.js/orderLifecycle.js/
// notifications.js). See CLAUDE.md's Phase 8D.2 section before touching
// this file, and supabase/migrations/0016_realtime_publication.sql for the
// (publication-membership-only, no RLS/RPC change) database side of this.
//
// THE ONE RULE THIS FILE EXISTS TO ENFORCE: a Realtime event is NEVER
// itself trusted for anything state- or security-relevant. Every handler
// below does exactly one thing — call the exact same authoritative
// refreshXCache() function view-entry/focus refresh already calls — and
// nothing else. This file never reads a payload's new/old row values for
// any decision; every event is treated as "something on this table
// changed, go refetch," never as "here is what changed." RLS, the
// lifecycle RPCs, and optimistic concurrency remain the entire
// security/consistency boundary, completely unchanged by this file's
// existence — a refetch can at worst show briefly-stale UI if it's ever
// wrong, exactly the same failure mode the pre-existing focus/view-entry
// refresh already has, never a false permission grant.
//
// TWO CHANNELS ONLY, matching the approved Phase 8D.2 architecture plan:
//   - a USER-scoped channel: `notifications` filtered to the current
//     recipient, alive for the whole authenticated session regardless of
//     which (or whether any) community is active.
//   - a COMMUNITY-scoped channel: every other approved table (orders,
//     cancellation_requests, sites, site_memberships, community_memberships,
//     owner_grants, buyer_grants, buyer_requests, communities), filtered to
//     the active community, torn down and recreated whenever the active
//     community changes — never recreated for a role switch, since no
//     channel here is role-scoped at all.
//
// LIFECYCLE — three exported entry points, all idempotent (safe to call
// redundantly — e.g. bootstrap running twice, or "switching" to the
// community that's already active):
//   startRealtimeForSession()             — call once a real user id
//                                            exists (login / session
//                                            restore). No-ops if there is
//                                            no authenticated user.
//   stopRealtime()                        — call on logout, and before a
//                                            different account's session
//                                            starts. Tears down BOTH
//                                            channels.
//   reinitializeRealtimeForCommunity(id)  — call whenever the active
//                                            community changes (id may be
//                                            null — the community channel
//                                            is simply torn down and not
//                                            recreated in that case). Also
//                                            self-triggered internally (see
//                                            the subscribeCommunities
//                                            wiring below) so nothing else
//                                            actually needs to remember to
//                                            call this — it's exported
//                                            mainly for explicitness/testing.
//
// REPLICA IDENTITY — see supabase/migrations/0016_realtime_publication.sql
// for the full story: `owner_grants`/`buyer_grants`/`site_memberships` run
// with REPLICA IDENTITY FULL, not Postgres's default, because a real local
// test caught a genuine bug — a DELETE's WAL entry under DEFAULT identity
// only carries primary-key columns, so a channel `filter` on a non-PK
// column (community_id, in every table's case here) can never match a
// DELETE event, and Realtime silently drops it rather than delivering or
// erroring. Every other approved table stays at DEFAULT deliberately —
// none of them are ever genuinely DELETEd anywhere in this codebase
// (status columns are updated instead), so the gap never actually applies
// to them.
//
// GENERATION GUARD — two INDEPENDENT counters, not one shared counter,
// because the notifications channel and the community channel are torn
// down/recreated on genuinely different triggers (session start/stop vs.
// every community switch) and must not invalidate each other's still-live
// callbacks — a community switch must never cause the (unchanged, still
// valid) notifications channel to start silently discarding real events.
// Each channel's event handler captures the generation value current at
// the moment that specific channel was created, and bails out before
// touching any cache if the counter has since moved on — this is what
// stops a slow removeChannel() teardown from racing a queued in-flight
// event from the OLD subscription's socket into refreshing state for a
// session/community that's no longer current. Same small-guard shape
// buyer.js's own holdGeneration already uses for an analogous "a slow async
// continuation might resolve after its own UI context is gone" problem —
// reused deliberately rather than inventing a second shape for one idea.
import { supabase } from './supabaseClient.js';
import { getCurrentUserId } from './identity.js';
import { getActiveCommunityId, subscribeCommunities } from './community.js';
import { refreshNotificationCache } from './notifications.js';
import { refreshOrderCache } from './orderLifecycle.js';
import { refreshCommunityCache } from './community.js';
import { refreshSitesCache } from './sites.js';

// --- Coalescing ----------------------------------------------------------
// A single lifecycle RPC can produce more than one Realtime event in quick
// succession (e.g. an orders UPDATE plus a notifications INSERT from the
// same transaction; a permission change touching two grant tables at once).
// Each domain gets its own tiny trailing-edge debounce so a burst of N
// same-domain events produces one refetch, not N — short enough (150ms)
// that no real user perceives added latency, long enough to collapse a
// same-transaction burst that arrives within a few ms of itself. This is
// deliberately NOT a queue/buffer of anything — just "if another one comes
// in before the timer fires, restart the timer," the simplest shape that
// satisfies "don't hammer Supabase" without any real complexity.
function coalesce(fn, ms = 150) {
  let timer = null;
  return () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(); }, ms);
  };
}

const coalescedRefreshNotifications = coalesce(refreshNotificationCache);
const coalescedRefreshOrders = coalesce(refreshOrderCache);
// Permission-relevant tables (sites/site_memberships/community_memberships/
// owner_grants/buyer_grants/buyer_requests/communities) always refresh BOTH
// caches together, deliberately — the exact same defensive pairing
// orderLifecycle.js's own handleRpcFailure already uses for a 42501
// (permission refused) failure, for the same reason: it's cheap at this
// app's scale, and simpler/safer than trying to know precisely which of
// the two caches a given table change could possibly affect.
const coalescedRefreshPermissions = coalesce(() => {
  refreshCommunityCache();
  refreshSitesCache();
});

// --- Channel state ---------------------------------------------------------
let notifChannel = null;
let notifGeneration = 0;
let notifConnectedBefore = false;

let communityChannel = null;
let communityGeneration = 0;
let communityChannelCommunityId = null; // which community the live channel is actually filtered to
let communityConnectedBefore = false;

function teardownNotifChannel() {
  notifGeneration += 1; // invalidates any in-flight event from the channel being removed
  notifConnectedBefore = false;
  if (notifChannel) {
    supabase.removeChannel(notifChannel);
    notifChannel = null;
  }
}

function teardownCommunityChannel() {
  communityGeneration += 1;
  communityConnectedBefore = false;
  communityChannelCommunityId = null;
  if (communityChannel) {
    supabase.removeChannel(communityChannel);
    communityChannel = null;
  }
}

function createNotifChannel(userId) {
  const myGeneration = notifGeneration;
  notifChannel = supabase
    .channel('realtime:notifications')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'notifications', filter: `recipient_user_id=eq.${userId}` },
      () => {
        if (myGeneration !== notifGeneration) return; // stale — this channel has since been torn down
        coalescedRefreshNotifications();
      }
    )
    .subscribe(status => {
      if (myGeneration !== notifGeneration) return;
      if (status === 'SUBSCRIBED') {
        // A reconnect (not the first connection) may have missed events
        // while disconnected — one authoritative refresh recovers from any
        // number of them, exactly like the existing focus-refresh already
        // does. No cursor/replay tracking; a full refetch is correct and
        // cheap at this app's scale.
        if (notifConnectedBefore) coalescedRefreshNotifications();
        notifConnectedBefore = true;
      }
    });
}

function createCommunityChannel(communityId) {
  const myGeneration = communityGeneration;
  communityChannelCommunityId = communityId;
  const filter = `community_id=eq.${communityId}`;
  let channel = supabase.channel('realtime:community');

  const orderTables = ['orders', 'cancellation_requests'];
  const permissionTables = [
    'sites', 'site_memberships', 'community_memberships',
    'owner_grants', 'buyer_grants', 'buyer_requests', 'communities',
  ];

  orderTables.forEach(table => {
    channel = channel.on(
      'postgres_changes',
      { event: '*', schema: 'public', table, filter },
      () => {
        if (myGeneration !== communityGeneration) return;
        coalescedRefreshOrders();
      }
    );
  });

  permissionTables.forEach(table => {
    // `communities` itself is filtered on its own primary key, not a
    // community_id foreign key column — every other table here uses
    // community_id.
    const tableFilter = table === 'communities' ? `id=eq.${communityId}` : filter;
    channel = channel.on(
      'postgres_changes',
      { event: '*', schema: 'public', table, filter: tableFilter },
      () => {
        if (myGeneration !== communityGeneration) return;
        coalescedRefreshPermissions();
      }
    );
  });

  channel.subscribe(status => {
    if (myGeneration !== communityGeneration) return;
    if (status === 'SUBSCRIBED') {
      if (communityConnectedBefore) {
        coalescedRefreshOrders();
        coalescedRefreshPermissions();
      }
      communityConnectedBefore = true;
    }
  });

  communityChannel = channel;
}

// --- Public lifecycle API -------------------------------------------------

// Idempotent: tears down any existing notifications channel first (a no-op
// if none exists), so calling this twice in a row — or once from bootstrap
// and once from a 'sitestock:logged-in' handler that happens to fire in the
// same tick — never produces two channels.
export function startRealtimeForSession() {
  const userId = getCurrentUserId();
  teardownNotifChannel();
  if (!userId) return; // never start an authenticated subscription without a real user
  createNotifChannel(userId);

  const communityId = getActiveCommunityId();
  if (communityId) reinitializeRealtimeForCommunity(communityId);
}

// Tears down BOTH channels. Safe to call when nothing is open.
export function stopRealtime() {
  teardownNotifChannel();
  teardownCommunityChannel();
}

// Tears down and recreates ONLY the community channel — the notifications
// channel is untouched, exactly per the approved design ("keep the user
// notification channel, replace only the community channel"). A no-op if
// communityId already matches the live channel's own scope (covers a role
// switch, which never changes the active community, and a redundant call
// with the same id).
export function reinitializeRealtimeForCommunity(communityId) {
  if (communityId === communityChannelCommunityId) return;
  teardownCommunityChannel();
  if (!communityId) return; // no active community — community channel simply doesn't exist
  createCommunityChannel(communityId);
}

// Self-wiring: detects an active-community change without community.js
// needing to import this module (which would create a circular
// community.js <-> realtime.js dependency — this file already imports FROM
// community.js for refreshCommunityCache/getActiveCommunityId/
// subscribeCommunities, so the dependency only ever flows one direction,
// matching every other cross-module dependency in this codebase). Fires on
// every community-cache notify(), including a role switch — reinitialize's
// own early-return above makes that call a correct no-op rather than this
// callback needing to know the difference.
let lastKnownCommunityId = undefined; // undefined (not null) = "haven't observed one yet"
subscribeCommunities(() => {
  const communityId = getActiveCommunityId();
  if (communityId === lastKnownCommunityId) return;
  lastKnownCommunityId = communityId;
  // Only reconcile the channel if a session is actually live — avoids
  // standing up a community channel from this reactive path alone before
  // startRealtimeForSession() has ever run for the current user (e.g.
  // during the earliest part of bootstrap, before auth is known).
  if (getCurrentUserId()) reinitializeRealtimeForCommunity(communityId);
});
