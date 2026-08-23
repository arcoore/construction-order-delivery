// Communities ("Companies" to the user) are now Supabase-backed (Phase 8B)
// — shared across devices/browsers for the first time, enforced server-side
// by RLS (see supabase/migrations/0009_rls_policies.sql). Ownership/
// membership is still keyed by user id, never display name (see
// identity.js), same as before.
//
// CACHE LIFECYCLE (read this before touching this file):
// Every read function below (isOwner, isApprovedMember, isBuyer,
// eligibleRoles, getCommunities, getOwnerIds, getBuyerIds, approvedMembers,
// etc.) is SYNCHRONOUS on purpose — orderLifecycle.js and the owner/buyer/
// driver/site UI modules call them inline inside synchronous render code,
// and none of those are being converted to async this phase (see
// CLAUDE.md's Phase 8B section). They read an in-memory cache
// (communities/memberships/owner_grants/buyer_grants/buyer_requests) kept
// fresh by real Supabase traffic, not by pretending a network call is
// instant.
//
// The cache is NEVER the authorization boundary — RLS is (see
// supabase/migrations/0009_rls_policies.sql). A stale cache can at worst
// show a UI affordance a user is no longer entitled to use; the moment they
// click it, the real Supabase write is independently checked server-side
// and refused if it should be. Every mutating function below refetches (or
// applies the server's own returned row) before resolving, so a caller that
// awaits a write always sees post-write truth, never an optimistic guess.
//
// Refresh triggers, all wired below or in main.js's bootstrap:
//   - on login/logout (via subscribeAuth)
//   - after every successful mutating call in this file (uses the server's
//     own response row, not a blind re-fetch, so it's never stale)
//   - explicit full refetch exposed as refreshCommunityCache(), called by
//     main.js on view entry into a role/community screen and on window
//     focus (see main.js's Phase 8B bootstrap section)
import { getCurrentUserId, primeProfiles } from './identity.js';
import { subscribeAuth } from './auth.js';
import { supabase } from './supabaseClient.js';

// --- UI-only local state (NOT retired to Supabase — see CLAUDE.md's
// "localStorage retirement" note: active community/role are browser session
// pointers, not security, and stay exactly as they were). --------------
const ACTIVE_COMMUNITY_KEY = 'sitestock_active_community_id';
const ACTIVE_ROLE_KEY = 'sitestock_active_role';
const SEEN_GRANTS_KEY = 'sitestock_seen_grants_v1'; // "have I shown this owner-upgrade popup" — UI state, not data

function readLocalList(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

const listeners = new Set();
function notify() {
  listeners.forEach(fn => fn());
}

export function subscribeCommunities(fn) {
  listeners.add(fn);
  fn();
  return () => listeners.delete(fn);
}

window.addEventListener('storage', e => {
  if (e.key === ACTIVE_COMMUNITY_KEY || e.key === ACTIVE_ROLE_KEY) notify();
});

export function getActiveCommunityId() {
  return localStorage.getItem(ACTIVE_COMMUNITY_KEY) || null;
}

export function getActiveCommunity() {
  const id = getActiveCommunityId();
  if (!id) return null;
  return getCommunities().find(c => c.id === id) || null;
}

export function setActiveCommunityId(id) {
  if (id) {
    localStorage.setItem(ACTIVE_COMMUNITY_KEY, id);
  } else {
    localStorage.removeItem(ACTIVE_COMMUNITY_KEY);
  }
  localStorage.removeItem(ACTIVE_ROLE_KEY);
  notify();
}

export function getActiveRole() {
  return localStorage.getItem(ACTIVE_ROLE_KEY) || null;
}

export function setActiveRole(role) {
  if (role) {
    localStorage.setItem(ACTIVE_ROLE_KEY, role);
  } else {
    localStorage.removeItem(ACTIVE_ROLE_KEY);
  }
  notify();
}

// --- Cache ----------------------------------------------------------
let cache = { communities: [], memberships: [], ownerGrants: [], buyerGrants: [], buyerRequests: [] };
export let communityCacheReady = false;

function mapCommunity(r) {
  return {
    id: r.id,
    name: r.name,
    code: r.invite_code,
    ownerId: r.owner_id,
    requireOwnerApproval: r.require_owner_approval,
    discoverable: r.discoverable,
    createdAt: new Date(r.created_at).getTime(),
  };
}
function mapMembership(r) {
  return {
    id: r.id,
    communityId: r.community_id,
    userId: r.user_id,
    status: r.status,
    requestedAt: new Date(r.requested_at).getTime(),
    decidedAt: r.decided_at ? new Date(r.decided_at).getTime() : null,
    decidedById: r.decided_by_id,
  };
}
function mapGrant(r) {
  return {
    id: r.id,
    communityId: r.community_id,
    userId: r.user_id,
    grantedById: r.granted_by_id,
    grantedAt: new Date(r.granted_at).getTime(),
  };
}
function mapBuyerRequest(r) {
  return {
    id: r.id,
    communityId: r.community_id,
    userId: r.user_id,
    status: r.status,
    requestedAt: new Date(r.requested_at).getTime(),
    decidedAt: r.decided_at ? new Date(r.decided_at).getTime() : null,
    decidedById: r.decided_by_id,
  };
}

// Full refetch of every table this module owns. Safe to call any time —
// called reactively on every auth transition below, and explicitly by
// main.js on relevant view entry / window focus (Phase 8B "no Realtime yet"
// freshness strategy — see CLAUDE.md). RLS scopes what actually comes back
// (e.g. community_memberships only returns rows the caller owns or owns the
// community for) so no client-side filtering by userId is needed here.
export async function refreshCommunityCache() {
  const userId = getCurrentUserId();
  if (!userId) {
    cache = { communities: [], memberships: [], ownerGrants: [], buyerGrants: [], buyerRequests: [] };
    communityCacheReady = true;
    notify();
    return;
  }
  const [communitiesRes, membershipsRes, ownerGrantsRes, buyerGrantsRes, buyerRequestsRes] = await Promise.all([
    supabase.from('communities').select('*'),
    supabase.from('community_memberships').select('*'),
    supabase.from('owner_grants').select('*'),
    supabase.from('buyer_grants').select('*'),
    supabase.from('buyer_requests').select('*'),
  ]);
  cache = {
    communities: (communitiesRes.data || []).map(mapCommunity),
    memberships: (membershipsRes.data || []).map(mapMembership),
    ownerGrants: (ownerGrantsRes.data || []).map(mapGrant),
    buyerGrants: (buyerGrantsRes.data || []).map(mapGrant),
    buyerRequests: (buyerRequestsRes.data || []).map(mapBuyerRequest),
  };
  communityCacheReady = true;

  // Proactively prime display names for every user id this cache load just
  // surfaced (owners, requesters, grant holders) — avoids a flash of
  // "Unknown" the first time each render calls resolveDisplayName for
  // someone the profile cache hasn't seen yet.
  const ids = new Set();
  cache.communities.forEach(c => ids.add(c.ownerId));
  cache.memberships.forEach(m => ids.add(m.userId));
  cache.ownerGrants.forEach(g => { ids.add(g.userId); ids.add(g.grantedById); });
  cache.buyerGrants.forEach(g => { ids.add(g.userId); ids.add(g.grantedById); });
  cache.buyerRequests.forEach(r => ids.add(r.userId));
  if (ids.size > 0) {
    const { data } = await supabase.from('profiles').select('id, display_name').in('id', Array.from(ids));
    if (data) primeProfiles(data);
  }

  notify();
}

// Refetches on every auth transition (login, logout, account switch) —
// clears to empty immediately on logout (see the userId-null branch above),
// loads fresh on login. This is in addition to main.js's explicit bootstrap
// await, which exists so the FIRST load is guaranteed complete before any
// routing happens (see main.js) — this subscription handles every
// subsequent transition during the session.
subscribeAuth(() => { refreshCommunityCache(); });

export function getCommunities() {
  return cache.communities;
}

export function getJoinRequests() {
  return cache.memberships;
}

export function eligibleRoles(communityId, userId) {
  const roles = [];
  if (isOwner(communityId, userId)) roles.push('owner');
  if (isApprovedMember(communityId, userId)) {
    roles.push('worker');
    roles.push('driver');
  }
  if (isBuyer(communityId, userId)) roles.push('buyer');
  return roles;
}

// Phase 8E — rewritten to make each rule explicit rather than incidental,
// per the approved routing checklist: exactly-one-role auto-enters, a valid
// preference is honoured, worker+driver-only ambiguity defaults to worker
// (unchanged precedent), and genuine multi-role ambiguity with no matching
// preference returns null so the caller shows the picker instead of
// guessing. Owner keeps its unconditional top priority — CLAUDE.md's
// documented rule ("no matter what they picked at signup") is unchanged.
export function resolveEntryRole(communityId, userId, preferredRole) {
  if (isOwner(communityId, userId)) return 'owner';

  const roles = eligibleRoles(communityId, userId); // never contains 'owner' here — isOwner already false
  if (roles.length === 0) return null;
  if (roles.length === 1) return roles[0];
  if (preferredRole && roles.includes(preferredRole)) return preferredRole;
  if (roles.length === 2 && roles.includes('worker') && roles.includes('driver')) return 'worker';
  return null;
}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

function generateInviteCode() {
  const existing = new Set(cache.communities.map(c => c.code));
  let code;
  do {
    code = Array.from({ length: 6 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  } while (existing.has(code));
  return code;
}

export async function createCommunity(name, ownerId) {
  const { data, error } = await supabase.from('communities').insert({
    name: name.trim(),
    invite_code: generateInviteCode(),
    owner_id: ownerId,
  }).select().single();
  if (error) return { error: error.message };
  const community = mapCommunity(data);
  cache.communities.push(community);
  notify();
  setActiveCommunityId(community.id);
  return { community };
}

// The creator is fixed at community creation and can never be changed here.
export function isCreator(communityId, userId) {
  const community = cache.communities.find(c => c.id === communityId);
  return !!community && !!userId && community.ownerId === userId;
}

export function getOwnerGrants() {
  return cache.ownerGrants;
}

export function hasOwnerGrant(communityId, userId) {
  return cache.ownerGrants.some(g => g.communityId === communityId && g.userId === userId);
}

// Owner-level access: the creator, or anyone the creator has granted access to.
export function isOwner(communityId, userId) {
  return isCreator(communityId, userId) || hasOwnerGrant(communityId, userId);
}

// Every user id currently holding owner access in this community (creator +
// all owner grants) — used to fan out notifications to "the owner(s)"
// rather than a single assumed owner. Called synchronously from
// orderLifecycle.js — must stay sync, cache-backed.
export function getOwnerIds(communityId) {
  const community = cache.communities.find(c => c.id === communityId);
  const ids = new Set();
  if (community) ids.add(community.ownerId);
  cache.ownerGrants.filter(g => g.communityId === communityId).forEach(g => ids.add(g.userId));
  return Array.from(ids);
}

export async function grantOwnerAccess(communityId, userId, grantedById) {
  if (cache.ownerGrants.some(g => g.communityId === communityId && g.userId === userId)) {
    return { ok: true, alreadyGranted: true };
  }
  const { data, error } = await supabase.from('owner_grants').insert({
    community_id: communityId, user_id: userId, granted_by_id: grantedById,
  }).select().single();
  if (error) return { ok: false, error: error.message };
  cache.ownerGrants.push(mapGrant(data));
  notify();
  return { ok: true };
}

export async function revokeOwnerAccess(communityId, userId) {
  const { error } = await supabase.from('owner_grants').delete()
    .eq('community_id', communityId).eq('user_id', userId);
  if (error) return { ok: false, error: error.message };
  cache.ownerGrants = cache.ownerGrants.filter(g => !(g.communityId === communityId && g.userId === userId));
  notify();
  return { ok: true };
}

export function approvedMembers(communityId) {
  const ids = cache.memberships
    .filter(r => r.communityId === communityId && r.status === 'approved')
    .map(r => r.userId);
  return Array.from(new Set(ids));
}

// Finds a grant made to this user that they haven't been shown the
// "upgraded to owner" popup for yet. Seen-state stays local/per-device on
// purpose (a UI "have I shown this" flag, not real data — same category as
// active community/role).
export function findUnseenGrantFor(userId) {
  if (!userId) return null;
  const seen = new Set(readLocalList(SEEN_GRANTS_KEY));
  return cache.ownerGrants.find(g => g.userId === userId && !seen.has(g.id)) || null;
}

export function markGrantSeen(grantId) {
  const seen = readLocalList(SEEN_GRANTS_KEY);
  if (!seen.includes(grantId)) {
    seen.push(grantId);
    localStorage.setItem(SEEN_GRANTS_KEY, JSON.stringify(seen));
  }
}

export function membershipStatus(communityId, userId) {
  if (isOwner(communityId, userId)) return 'owner';
  const req = cache.memberships.find(r => r.communityId === communityId && r.userId === userId);
  return req ? req.status : 'none';
}

export function isApprovedMember(communityId, userId) {
  const status = membershipStatus(communityId, userId);
  return status === 'owner' || status === 'approved';
}

export async function requestToJoin(communityId, userId) {
  const existing = cache.memberships.find(r => r.communityId === communityId && r.userId === userId);
  if (existing) return existing;
  const { data, error } = await supabase.from('community_memberships').insert({
    community_id: communityId, user_id: userId, status: 'pending',
  }).select().single();
  if (error) return { error: error.message };
  const request = mapMembership(data);
  cache.memberships.push(request);
  notify();
  return request;
}

// Roadmap Step 5 — rewritten to call the server-authoritative
// request_join_by_invite_code RPC instead of scanning the client-side
// `cache.communities` array. That client-side scan only ever worked because
// every community used to be SELECTable by every authenticated user
// (communities_select_any); since migration 0021 scopes SELECT to
// owner/member/pending-requester/discoverable=true, a private community the
// caller isn't already related to is no longer in that cache at all, so the
// old scan would silently never find it. The RPC resolves the code with
// elevated privilege server-side and returns only the one matched
// community's id/name plus the caller's own resulting status — never a
// list, never enabling enumeration. Same external return shape as before
// (`{ error }` / `{ community, alreadyMember: true }` /
// `{ community, alreadyPending: true }` / `{ community, requested: true }`)
// so every existing call site (communityView.js) needed zero changes.
// Refreshes the full community cache on success so the newly-visible
// community/membership row are both reflected immediately, exactly like
// every other mutating function in this file already does.
export async function requestToJoinByCode(code, userId) {
  const { data, error } = await supabase.rpc('request_join_by_invite_code', { p_code: code.trim() });
  if (error) return { error: error.message };
  if (!data.ok) return { error: 'No community found with that invite code.' };

  const community = { id: data.communityId, name: data.communityName };
  if (data.status === 'owner') return { error: `You're already the owner of "${community.name}".` };
  if (data.status === 'approved') return { community, alreadyMember: true };
  // justCreated distinguishes a genuinely fresh pending row from one that
  // already existed — both carry status 'pending' with nothing else to
  // tell them apart (found live: without this check, a real first-time
  // joiner incorrectly saw "Already requested" instead of "Request sent").
  if (data.status === 'pending' && !data.justCreated) return { community, alreadyPending: true };

  await refreshCommunityCache();
  return { community, requested: true };
}

// --- Roadmap Step 5: discoverability + shareable invite links ---------

// Plain client-side update, exactly like setApprovalRequired below —
// communities_update_owner_only RLS already scopes this to is_owner, no new
// RPC needed for a single-column owner-settable toggle.
export async function setDiscoverable(communityId, value) {
  const { data, error } = await supabase.from('communities')
    .update({ discoverable: !!value })
    .eq('id', communityId)
    .select()
    .single();
  if (error) return { ok: false, error: error.message };
  const idx = cache.communities.findIndex(c => c.id === communityId);
  if (idx !== -1) cache.communities[idx] = mapCommunity(data);
  notify();
  return { ok: true };
}

// The invite link is a pure wrapper around the existing invite code — no
// new invite mechanism, just a URL that pre-fills the join form so someone
// doesn't have to type 6 characters correctly. Query string, not hash — the
// hash is reserved for Supabase's own password-recovery link (see
// supabaseClient.js/auth.js).
export function buildInviteLink(code) {
  return `${window.location.origin}${window.location.pathname}?join=${encodeURIComponent(code)}`;
}

// Held in memory only (never localStorage) — a one-time intent for this
// page load, not session state. Read once at bootstrap (main.js), stripped
// from the URL immediately via history.replaceState so refreshing/sharing
// the resulting tab doesn't repeat the join prompt, then carried in memory
// across whatever signup/login happens before it's actually consumed.
let pendingJoinCode = null;

export function consumeJoinIntentFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('join');
  if (code) {
    pendingJoinCode = code;
    params.delete('join');
    const qs = params.toString();
    const newUrl = window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash;
    window.history.replaceState(null, '', newUrl);
  }
  return pendingJoinCode;
}

export function getPendingJoinCode() {
  return pendingJoinCode;
}

export function clearPendingJoinCode() {
  pendingJoinCode = null;
}

export async function decideJoinRequest(requestId, decision, decidedById) {
  const { data, error } = await supabase.from('community_memberships')
    .update({ status: decision, decided_at: new Date().toISOString(), decided_by_id: decidedById })
    .eq('id', requestId)
    .select()
    .single();
  if (error) return { ok: false, error: error.message };
  const mapped = mapMembership(data);
  const idx = cache.memberships.findIndex(r => r.id === requestId);
  if (idx === -1) cache.memberships.push(mapped); else cache.memberships[idx] = mapped;
  notify();
  return { ok: true };
}

export function approvedMemberCount(communityId) {
  const approved = cache.memberships.filter(r => r.communityId === communityId && r.status === 'approved').length;
  return approved + 1; // +1 for the owner, who isn't a membership row
}

export function myCommunities(userId) {
  if (!userId) return [];
  return cache.communities.filter(c => isApprovedMember(c.id, userId));
}

export function myPendingRequests(userId) {
  if (!userId) return [];
  return cache.memberships.filter(r => r.status === 'pending' && r.userId === userId);
}

export function isApprovalRequired(communityId) {
  const community = cache.communities.find(c => c.id === communityId);
  return !community || community.requireOwnerApproval !== false;
}

export async function setApprovalRequired(communityId, required) {
  const { data, error } = await supabase.from('communities')
    .update({ require_owner_approval: !!required })
    .eq('id', communityId)
    .select()
    .single();
  if (error) return { ok: false, error: error.message };
  const idx = cache.communities.findIndex(c => c.id === communityId);
  if (idx !== -1) cache.communities[idx] = mapCommunity(data);
  notify();
  return { ok: true };
}

export function getBuyerGrants() {
  return cache.buyerGrants;
}

export function hasBuyerGrant(communityId, userId) {
  return cache.buyerGrants.some(g => g.communityId === communityId && g.userId === userId);
}

export function isBuyer(communityId, userId) {
  return hasBuyerGrant(communityId, userId);
}

// Called synchronously from orderLifecycle.js — must stay sync, cache-backed.
export function getBuyerIds(communityId) {
  return Array.from(new Set(cache.buyerGrants.filter(g => g.communityId === communityId).map(g => g.userId)));
}

export async function grantBuyerAccess(communityId, userId, grantedById) {
  if (cache.buyerGrants.some(g => g.communityId === communityId && g.userId === userId)) {
    return { ok: true, alreadyGranted: true };
  }
  const { data, error } = await supabase.from('buyer_grants').insert({
    community_id: communityId, user_id: userId, granted_by_id: grantedById,
  }).select().single();
  if (error) return { ok: false, error: error.message };
  cache.buyerGrants.push(mapGrant(data));
  notify();

  // Best-effort: the grant itself already succeeded and is the thing that
  // actually matters — a notify failure here is logged, never allowed to
  // make an already-successful grant look like it failed.
  const { error: notifyError } = await supabase.rpc('notify_buyer_access_granted', {
    p_community_id: communityId, p_recipient_id: userId,
  });
  if (notifyError) console.error('notify_buyer_access_granted failed:', notifyError.message);
  return { ok: true };
}

// Phase 8D.1 hardening (0015): the removal and its notification are now one
// atomic server-side operation (revoke_buyer_access RPC) — the database
// itself proves a real grant existed before any notification is created,
// rather than a client delete followed by a separately-trusted notify call.
// See 0015_revoke_remove_notification_integrity.sql for the full rationale.
export async function revokeBuyerAccess(communityId, userId, revokedById) {
  const { error } = await supabase.rpc('revoke_buyer_access', {
    p_community_id: communityId, p_recipient_id: userId,
  });
  if (error) return { ok: false, error: error.message };
  cache.buyerGrants = cache.buyerGrants.filter(g => !(g.communityId === communityId && g.userId === userId));
  notify();
  return { ok: true };
}

export function getBuyerRequests() {
  return cache.buyerRequests;
}

export function buyerRequestStatus(communityId, userId) {
  if (hasBuyerGrant(communityId, userId)) return 'granted';
  const req = cache.buyerRequests.find(r => r.communityId === communityId && r.userId === userId);
  return req ? req.status : 'none';
}

export async function requestBuyerRole(communityId, userId) {
  const existing = cache.buyerRequests.find(r => r.communityId === communityId && r.userId === userId);
  if (existing) return existing;
  const { data, error } = await supabase.from('buyer_requests').insert({
    community_id: communityId, user_id: userId, status: 'pending',
  }).select().single();
  if (error) return { error: error.message };
  const request = mapBuyerRequest(data);
  cache.buyerRequests.push(request);
  notify();

  const { error: notifyError } = await supabase.rpc('notify_buyer_access_requested', { p_request_id: request.id });
  if (notifyError) console.error('notify_buyer_access_requested failed:', notifyError.message);
  return request;
}

// Approving a buyer request also grants access in one step — grantBuyerAccess
// fires its own notification, so the approved path is covered without
// duplicating it here.
export async function decideBuyerRequest(requestId, decision, decidedById) {
  const request = cache.buyerRequests.find(r => r.id === requestId);
  if (!request) return { ok: false, error: 'Request not found.' };
  const { data, error } = await supabase.from('buyer_requests')
    .update({ status: decision, decided_at: new Date().toISOString(), decided_by_id: decidedById })
    .eq('id', requestId)
    .select()
    .single();
  if (error) return { ok: false, error: error.message };
  const mapped = mapBuyerRequest(data);
  const idx = cache.buyerRequests.findIndex(r => r.id === requestId);
  if (idx !== -1) cache.buyerRequests[idx] = mapped;
  notify();

  if (decision === 'approved') {
    await grantBuyerAccess(mapped.communityId, mapped.userId, decidedById);
  } else {
    const { error: notifyError } = await supabase.rpc('notify_buyer_access_rejected', { p_request_id: requestId });
    if (notifyError) console.error('notify_buyer_access_rejected failed:', notifyError.message);
  }
  return { ok: true };
}
