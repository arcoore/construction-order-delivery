// Communities are the "Discord server" layer: an owner creates one, workers
// and drivers join it (by code or by browsing + requesting), and every order
// is scoped to a single community. Everything still lives in this browser's
// localStorage — there's no backend yet, so "inviting" only works within the
// same browser for now.
const COMMUNITIES_KEY = 'sitestock_communities_v1';
const REQUESTS_KEY = 'sitestock_join_requests_v1';
const IDENTITY_KEY = 'sitestock_identity_name';
const ACTIVE_COMMUNITY_KEY = 'sitestock_active_community_id';
const ACTIVE_ROLE_KEY = 'sitestock_active_role';
const OWNER_GRANTS_KEY = 'sitestock_owner_grants_v1';
const SEEN_GRANTS_KEY = 'sitestock_seen_grants_v1';

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
    e.key === ACTIVE_ROLE_KEY || e.key === OWNER_GRANTS_KEY
  ) notify();
});

export function getCommunities() {
  return readList(COMMUNITIES_KEY);
}

export function getJoinRequests() {
  return readList(REQUESTS_KEY);
}

export function getIdentityName() {
  return (localStorage.getItem(IDENTITY_KEY) || '').trim();
}

export function setIdentityName(name) {
  localStorage.setItem(IDENTITY_KEY, name.trim());
  notify();
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

export function eligibleRoles(communityId, name) {
  const roles = [];
  if (isOwner(communityId, name)) roles.push('owner');
  if (isApprovedMember(communityId, name)) {
    roles.push('worker');
    roles.push('driver');
  }
  return roles;
}

// Resolves which screen someone should land on in a given community, with no
// prompt needed: owner access always wins if they actually have it (creator
// or granted) — regardless of what they picked at signup — since owning a
// community is a real permission, not a preference. Otherwise falls back to
// their account's chosen role (worker/driver), or worker if that doesn't
// apply here either.
export function resolveEntryRole(communityId, name, preferredRole) {
  if (isOwner(communityId, name)) return 'owner';
  if ((preferredRole === 'worker' || preferredRole === 'driver') && isApprovedMember(communityId, name)) {
    return preferredRole;
  }
  if (isApprovedMember(communityId, name)) return 'worker';
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

export function createCommunity(name, ownerName) {
  const community = {
    id: newId('c'),
    name: name.trim(),
    code: generateInviteCode(),
    ownerName: ownerName.trim(),
    createdAt: Date.now(),
  };
  const communities = getCommunities();
  communities.push(community);
  writeList(COMMUNITIES_KEY, communities);
  setActiveCommunityId(community.id);
  return community;
}

// The creator is fixed at community creation and can never be changed here.
export function isCreator(communityId, name) {
  const community = getCommunities().find(c => c.id === communityId);
  return !!community && community.ownerName.toLowerCase() === (name || '').trim().toLowerCase();
}

export function getOwnerGrants() {
  return readList(OWNER_GRANTS_KEY);
}

export function hasOwnerGrant(communityId, name) {
  const cleanName = (name || '').trim().toLowerCase();
  return getOwnerGrants().some(g => g.communityId === communityId && g.name.trim().toLowerCase() === cleanName);
}

// Owner-level access: the creator, or anyone the creator has granted access to.
export function isOwner(communityId, name) {
  return isCreator(communityId, name) || hasOwnerGrant(communityId, name);
}

export function grantOwnerAccess(communityId, name, grantedBy) {
  const cleanName = name.trim().toLowerCase();
  const grants = getOwnerGrants();
  if (grants.some(g => g.communityId === communityId && g.name.trim().toLowerCase() === cleanName)) {
    return;
  }
  grants.push({
    id: newId('og'),
    communityId,
    name: name.trim(),
    grantedBy,
    grantedAt: Date.now(),
  });
  writeList(OWNER_GRANTS_KEY, grants);
}

export function revokeOwnerAccess(communityId, name) {
  const cleanName = name.trim().toLowerCase();
  const grants = getOwnerGrants().filter(
    g => !(g.communityId === communityId && g.name.trim().toLowerCase() === cleanName)
  );
  writeList(OWNER_GRANTS_KEY, grants);
}

export function approvedMembers(communityId) {
  const names = getJoinRequests()
    .filter(r => r.communityId === communityId && r.status === 'approved')
    .map(r => r.name);
  return Array.from(new Set(names));
}

// Finds a grant made to this identity that they haven't been shown the
// "upgraded to owner" popup for yet.
export function findUnseenGrantFor(name) {
  const cleanName = (name || '').trim().toLowerCase();
  if (!cleanName) return null;
  const seen = new Set(readList(SEEN_GRANTS_KEY));
  return getOwnerGrants().find(g => g.name.trim().toLowerCase() === cleanName && !seen.has(g.id)) || null;
}

export function markGrantSeen(grantId) {
  const seen = readList(SEEN_GRANTS_KEY);
  if (!seen.includes(grantId)) {
    seen.push(grantId);
    localStorage.setItem(SEEN_GRANTS_KEY, JSON.stringify(seen));
  }
}

export function membershipStatus(communityId, name) {
  const cleanName = name.trim().toLowerCase();
  if (isOwner(communityId, cleanName)) return 'owner';
  const req = getJoinRequests().find(
    r => r.communityId === communityId && r.name.trim().toLowerCase() === cleanName
  );
  return req ? req.status : 'none';
}

export function isApprovedMember(communityId, name) {
  const status = membershipStatus(communityId, name);
  return status === 'owner' || status === 'approved';
}

export function requestToJoin(communityId, name) {
  const existing = getJoinRequests();
  const cleanName = name.trim().toLowerCase();
  const already = existing.find(r => r.communityId === communityId && r.name.trim().toLowerCase() === cleanName);
  if (already) return already;
  const request = {
    id: newId('r'),
    communityId,
    name: name.trim(),
    status: 'pending',
    requestedAt: Date.now(),
    decidedAt: null,
    decidedBy: null,
  };
  existing.push(request);
  writeList(REQUESTS_KEY, existing);
  return request;
}

export function requestToJoinByCode(code, name) {
  const community = getCommunities().find(c => c.code.toUpperCase() === code.trim().toUpperCase());
  if (!community) return { error: 'No community found with that invite code.' };
  const status = membershipStatus(community.id, name);
  if (status === 'owner') return { error: `You're already the owner of "${community.name}".` };
  if (status === 'approved') return { community, alreadyMember: true };
  if (status === 'pending') return { community, alreadyPending: true };
  requestToJoin(community.id, name);
  return { community, requested: true };
}

export function decideJoinRequest(requestId, decision, decidedBy) {
  const requests = getJoinRequests();
  const idx = requests.findIndex(r => r.id === requestId);
  if (idx === -1) return;
  requests[idx] = {
    ...requests[idx],
    status: decision,
    decidedAt: Date.now(),
    decidedBy,
  };
  writeList(REQUESTS_KEY, requests);
}

export function approvedMemberCount(communityId) {
  const approved = getJoinRequests().filter(r => r.communityId === communityId && r.status === 'approved').length;
  return approved + 1; // +1 for the owner, who isn't a join request
}

export function myCommunities(name) {
  const cleanName = name.trim().toLowerCase();
  if (!cleanName) return [];
  return getCommunities().filter(c => isApprovedMember(c.id, cleanName));
}

export function myPendingRequests(name) {
  const cleanName = name.trim().toLowerCase();
  return getJoinRequests().filter(r => r.status === 'pending' && r.name.trim().toLowerCase() === cleanName);
}
