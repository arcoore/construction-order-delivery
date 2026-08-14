// Communities are the "Discord server" layer: an owner creates one, workers
// and drivers join it (by code or by browsing + requesting), and every order
// is scoped to a single community. Everything still lives in this browser's
// localStorage — there's no backend yet, so "inviting" only works within the
// same browser for now.
//
// Membership/ownership here is keyed by user id (see identity.js), never by
// display name — see CLAUDE.md's "Owner permission model" and identity.js's
// header comment for why.
//
// resolveDisplayName/notifyUsers are used only for notification content
// generation (role-grant/request actions below) — never for any permission
// or routing decision, which stays 100% id-based throughout this file.
import { resolveDisplayName } from './identity.js';
import { notifyUsers } from './notifications.js';

const COMMUNITIES_KEY = 'sitestock_communities_v2';
const REQUESTS_KEY = 'sitestock_join_requests_v2';
const ACTIVE_COMMUNITY_KEY = 'sitestock_active_community_id';
const ACTIVE_ROLE_KEY = 'sitestock_active_role';
const OWNER_GRANTS_KEY = 'sitestock_owner_grants_v2';
const SEEN_GRANTS_KEY = 'sitestock_seen_grants_v1';
const BUYER_GRANTS_KEY = 'sitestock_buyer_grants_v1';
const BUYER_REQUESTS_KEY = 'sitestock_buyer_requests_v1';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

function readList(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function writeList(key, list) {
  localStorage.setItem(key, JSON.stringify(list));
  notify();
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
  if (
    e.key === COMMUNITIES_KEY || e.key === REQUESTS_KEY || e.key === ACTIVE_COMMUNITY_KEY ||
    e.key === ACTIVE_ROLE_KEY || e.key === OWNER_GRANTS_KEY || e.key === BUYER_GRANTS_KEY ||
    e.key === BUYER_REQUESTS_KEY
  ) notify();
});

export function getCommunities() {
  return readList(COMMUNITIES_KEY);
}

export function getJoinRequests() {
  return readList(REQUESTS_KEY);
}

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

// Resolves which screen someone should land on in a given community, with no
// prompt needed: owner access always wins if they actually have it (creator
// or granted) — regardless of what they picked at signup — since owning a
// community is a real permission, not a preference. Otherwise falls back to
// their account's chosen role (worker/driver/buyer), or worker if that
// doesn't apply here either.
export function resolveEntryRole(communityId, userId, preferredRole) {
  if (isOwner(communityId, userId)) return 'owner';
  if (preferredRole === 'buyer' && isBuyer(communityId, userId)) return 'buyer';
  if ((preferredRole === 'worker' || preferredRole === 'driver') && isApprovedMember(communityId, userId)) {
    return preferredRole;
  }
  if (isApprovedMember(communityId, userId)) return 'worker';
  return null;
}

function generateInviteCode() {
  const existing = new Set(getCommunities().map(c => c.code));
  let code;
  do {
    code = Array.from({ length: 6 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  } while (existing.has(code));
  return code;
}

function newId(prefix) {
  const rand = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${rand}`;
}

export function createCommunity(name, ownerId) {
  const community = {
    id: newId('c'),
    name: name.trim(),
    code: generateInviteCode(),
    ownerId,
    createdAt: Date.now(),
  };
  const communities = getCommunities();
  communities.push(community);
  writeList(COMMUNITIES_KEY, communities);
  setActiveCommunityId(community.id);
  return community;
}

// The creator is fixed at community creation and can never be changed here.
export function isCreator(communityId, userId) {
  const community = getCommunities().find(c => c.id === communityId);
  return !!community && !!userId && community.ownerId === userId;
}

export function getOwnerGrants() {
  return readList(OWNER_GRANTS_KEY);
}

export function hasOwnerGrant(communityId, userId) {
  return getOwnerGrants().some(g => g.communityId === communityId && g.userId === userId);
}

// Owner-level access: the creator, or anyone the creator has granted access to.
export function isOwner(communityId, userId) {
  return isCreator(communityId, userId) || hasOwnerGrant(communityId, userId);
}

// Every user id currently holding owner access in this community (creator +
// all owner grants) — used to fan out notifications to "the owner(s)"
// rather than a single assumed owner.
export function getOwnerIds(communityId) {
  const community = getCommunities().find(c => c.id === communityId);
  const ids = new Set();
  if (community) ids.add(community.ownerId);
  getOwnerGrants().filter(g => g.communityId === communityId).forEach(g => ids.add(g.userId));
  return Array.from(ids);
}

export function grantOwnerAccess(communityId, userId, grantedById) {
  const grants = getOwnerGrants();
  if (grants.some(g => g.communityId === communityId && g.userId === userId)) {
    return;
  }
  grants.push({
    id: newId('og'),
    communityId,
    userId,
    grantedById,
    grantedAt: Date.now(),
  });
  writeList(OWNER_GRANTS_KEY, grants);
}

export function revokeOwnerAccess(communityId, userId) {
  const grants = getOwnerGrants().filter(
    g => !(g.communityId === communityId && g.userId === userId)
  );
  writeList(OWNER_GRANTS_KEY, grants);
}

export function approvedMembers(communityId) {
  const ids = getJoinRequests()
    .filter(r => r.communityId === communityId && r.status === 'approved')
    .map(r => r.userId);
  return Array.from(new Set(ids));
}

// Finds a grant made to this user that they haven't been shown the
// "upgraded to owner" popup for yet.
export function findUnseenGrantFor(userId) {
  if (!userId) return null;
  const seen = new Set(readList(SEEN_GRANTS_KEY));
  return getOwnerGrants().find(g => g.userId === userId && !seen.has(g.id)) || null;
}

export function markGrantSeen(grantId) {
  const seen = readList(SEEN_GRANTS_KEY);
  if (!seen.includes(grantId)) {
    seen.push(grantId);
    localStorage.setItem(SEEN_GRANTS_KEY, JSON.stringify(seen));
  }
}

export function membershipStatus(communityId, userId) {
  if (isOwner(communityId, userId)) return 'owner';
  const req = getJoinRequests().find(
    r => r.communityId === communityId && r.userId === userId
  );
  return req ? req.status : 'none';
}

export function isApprovedMember(communityId, userId) {
  const status = membershipStatus(communityId, userId);
  return status === 'owner' || status === 'approved';
}

export function requestToJoin(communityId, userId) {
  const existing = getJoinRequests();
  const already = existing.find(r => r.communityId === communityId && r.userId === userId);
  if (already) return already;
  const request = {
    id: newId('r'),
    communityId,
    userId,
    status: 'pending',
    requestedAt: Date.now(),
    decidedAt: null,
    decidedById: null,
  };
  existing.push(request);
  writeList(REQUESTS_KEY, existing);
  return request;
}

export function requestToJoinByCode(code, userId) {
  const community = getCommunities().find(c => c.code.toUpperCase() === code.trim().toUpperCase());
  if (!community) return { error: 'No community found with that invite code.' };
  const status = membershipStatus(community.id, userId);
  if (status === 'owner') return { error: `You're already the owner of "${community.name}".` };
  if (status === 'approved') return { community, alreadyMember: true };
  if (status === 'pending') return { community, alreadyPending: true };
  requestToJoin(community.id, userId);
  return { community, requested: true };
}

export function decideJoinRequest(requestId, decision, decidedById) {
  const requests = getJoinRequests();
  const idx = requests.findIndex(r => r.id === requestId);
  if (idx === -1) return;
  requests[idx] = {
    ...requests[idx],
    status: decision,
    decidedAt: Date.now(),
    decidedById,
  };
  writeList(REQUESTS_KEY, requests);
}

export function approvedMemberCount(communityId) {
  const approved = getJoinRequests().filter(r => r.communityId === communityId && r.status === 'approved').length;
  return approved + 1; // +1 for the owner, who isn't a join request
}

export function myCommunities(userId) {
  if (!userId) return [];
  return getCommunities().filter(c => isApprovedMember(c.id, userId));
}

export function myPendingRequests(userId) {
  if (!userId) return [];
  return getJoinRequests().filter(r => r.status === 'pending' && r.userId === userId);
}

// Whether new orders in this community need owner approval before moving to
// purchase. Defaults true for communities created before this setting
// existed (additive field, no version bump needed).
export function isApprovalRequired(communityId) {
  const community = getCommunities().find(c => c.id === communityId);
  return !community || community.requireOwnerApproval !== false;
}

export function setApprovalRequired(communityId, required) {
  const communities = getCommunities();
  const idx = communities.findIndex(c => c.id === communityId);
  if (idx === -1) return;
  communities[idx] = { ...communities[idx], requireOwnerApproval: !!required };
  writeList(COMMUNITIES_KEY, communities);
}

// Buyer access is owner-granted only — never automatic for approved members
// (unlike worker/driver) — since it carries real purchasing/financial
// responsibility. Mirrors the owner-grant shape in community.js exactly.
export function getBuyerGrants() {
  return readList(BUYER_GRANTS_KEY);
}

export function hasBuyerGrant(communityId, userId) {
  return getBuyerGrants().some(g => g.communityId === communityId && g.userId === userId);
}

export function isBuyer(communityId, userId) {
  return hasBuyerGrant(communityId, userId);
}

// Every user id currently holding buyer access in this community.
export function getBuyerIds(communityId) {
  return Array.from(new Set(getBuyerGrants().filter(g => g.communityId === communityId).map(g => g.userId)));
}

// Fires the same buyer_access_granted notification whether access came from
// a direct grant (Team panel) or an approved request (decideBuyerRequest
// below calls this too) — one place, so the two paths can never drift.
export function grantBuyerAccess(communityId, userId, grantedById) {
  const grants = getBuyerGrants();
  if (grants.some(g => g.communityId === communityId && g.userId === userId)) {
    return;
  }
  grants.push({
    id: newId('bg'),
    communityId,
    userId,
    grantedById,
    grantedAt: Date.now(),
  });
  writeList(BUYER_GRANTS_KEY, grants);

  const granterName = resolveDisplayName(grantedById);
  notifyUsers([userId], {
    type: 'buyer_access_granted',
    title: "You've been granted buyer access",
    message: `${granterName} gave you buyer access.`,
    communityId,
    actorId: grantedById,
    actorName: granterName,
    navigationTarget: { communityId, role: 'buyer' },
  });
}

export function revokeBuyerAccess(communityId, userId, revokedById) {
  const grants = getBuyerGrants().filter(
    g => !(g.communityId === communityId && g.userId === userId)
  );
  writeList(BUYER_GRANTS_KEY, grants);

  const revokerName = resolveDisplayName(revokedById);
  notifyUsers([userId], {
    type: 'buyer_access_revoked',
    title: 'Buyer access removed',
    message: `${revokerName} removed your buyer access.`,
    communityId,
    actorId: revokedById,
    actorName: revokerName,
    navigationTarget: { communityId },
  });
}

export function getBuyerRequests() {
  return readList(BUYER_REQUESTS_KEY);
}

export function buyerRequestStatus(communityId, userId) {
  if (hasBuyerGrant(communityId, userId)) return 'granted';
  const req = getBuyerRequests().find(r => r.communityId === communityId && r.userId === userId);
  return req ? req.status : 'none';
}

export function requestBuyerRole(communityId, userId) {
  const existing = getBuyerRequests();
  const already = existing.find(r => r.communityId === communityId && r.userId === userId);
  if (already) return already;
  const request = {
    id: newId('br'),
    communityId,
    userId,
    status: 'pending',
    requestedAt: Date.now(),
    decidedAt: null,
    decidedById: null,
  };
  existing.push(request);
  writeList(BUYER_REQUESTS_KEY, existing);

  const requesterName = resolveDisplayName(userId);
  notifyUsers(getOwnerIds(communityId), {
    type: 'buyer_access_requested',
    title: 'Buyer access requested',
    message: `${requesterName} requested buyer access.`,
    communityId,
    requestId: request.id,
    actorId: userId,
    actorName: requesterName,
    navigationTarget: { communityId, role: 'owner' },
  });

  return request;
}

// Approving a buyer request also grants access in one step — a separate
// "approve, then also remember to grant" motion would be an easy way for
// the two to drift out of sync. grantBuyerAccess fires its own notification,
// so the approved path is covered without duplicating it here.
export function decideBuyerRequest(requestId, decision, decidedById) {
  const requests = getBuyerRequests();
  const idx = requests.findIndex(r => r.id === requestId);
  if (idx === -1) return;
  const request = requests[idx];
  requests[idx] = { ...request, status: decision, decidedAt: Date.now(), decidedById };
  writeList(BUYER_REQUESTS_KEY, requests);
  if (decision === 'approved') {
    grantBuyerAccess(request.communityId, request.userId, decidedById);
  } else {
    const deciderName = resolveDisplayName(decidedById);
    notifyUsers([request.userId], {
      type: 'buyer_access_rejected',
      title: 'Buyer access request declined',
      message: `${deciderName} declined your buyer access request.`,
      communityId: request.communityId,
      requestId: request.id,
      actorId: decidedById,
      actorName: deciderName,
      navigationTarget: { communityId: request.communityId, view: 'profile' },
    });
  }
}
