// Sites are individual job locations that live inside a single community — a
// company can have many, and orders belong to exactly one. Like community.js,
// every permission/membership check here is keyed by user id (see
// identity.js), never by display name, and every check takes communityId
// explicitly rather than trusting whichever community happens to be "active"
// in session state — this is what keeps access to one company's sites from
// ever leaking into another's, even if a user belongs to (or switches
// between) multiple communities.
//
// A siteId/order reference is never itself a permission — every read/write
// path here re-derives access from current isOwner/isApprovedMember/isBuyer
// (community.js) plus live site-membership state, the same "reference is not
// permission" discipline notifications.js and orderLifecycle.js already
// follow.
import { isOwner, isApprovedMember, isBuyer } from './community.js';
import { resolveDisplayName } from './identity.js';

const SITES_KEY = 'sitestock_sites_v1';
const MEMBERSHIPS_KEY = 'sitestock_site_memberships_v1';

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

export function subscribeSites(fn) {
  listeners.add(fn);
  fn();
  return () => listeners.delete(fn);
}

window.addEventListener('storage', e => {
  if (e.key === SITES_KEY || e.key === MEMBERSHIPS_KEY) notify();
});

function newId(prefix) {
  const rand = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${rand}`;
}

// --- Site CRUD --------------------------------------------------------

export function getSites(communityId) {
  return readList(SITES_KEY).filter(s => s.communityId === communityId);
}

export function getActiveSites(communityId) {
  return getSites(communityId).filter(s => s.status === 'active');
}

export function getSite(siteId) {
  return readList(SITES_KEY).find(s => s.id === siteId) || null;
}

export function createSite(communityId, fields, actorId) {
  if (!isOwner(communityId, actorId)) {
    return { ok: false, error: 'Only the owner can create sites.' };
  }
  const name = (fields.name || '').trim();
  if (!name) {
    return { ok: false, error: 'Site name is required.' };
  }
  const actorName = resolveDisplayName(actorId);
  const site = {
    id: newId('site'),
    communityId,
    name,
    address: (fields.address || '').trim(),
    postcode: (fields.postcode || '').trim(),
    deliveryInstructions: (fields.deliveryInstructions || '').trim(),
    status: 'active',
    createdAt: Date.now(),
    createdById: actorId,
    createdBy: actorName,
    updatedAt: Date.now(),
    archivedAt: null,
    archivedById: null,
    archivedBy: null,
  };
  const sites = readList(SITES_KEY);
  sites.push(site);
  writeList(SITES_KEY, sites);
  return { ok: true, site };
}

export function updateSite(siteId, patch, actorId) {
  const sites = readList(SITES_KEY);
  const idx = sites.findIndex(s => s.id === siteId);
  if (idx === -1) return { ok: false, error: 'Site not found.' };
  const site = sites[idx];
  if (!isOwner(site.communityId, actorId)) {
    return { ok: false, error: 'Only the owner can edit sites.' };
  }
  const next = { ...site, updatedAt: Date.now() };
  if (patch.name !== undefined) {
    const trimmed = patch.name.trim();
    if (!trimmed) return { ok: false, error: 'Site name is required.' };
    next.name = trimmed;
  }
  if (patch.address !== undefined) next.address = (patch.address || '').trim();
  if (patch.postcode !== undefined) next.postcode = (patch.postcode || '').trim();
  if (patch.deliveryInstructions !== undefined) next.deliveryInstructions = (patch.deliveryInstructions || '').trim();
  sites[idx] = next;
  writeList(SITES_KEY, sites);
  return { ok: true, site: next };
}

function setSiteStatus(siteId, status, actorId) {
  const sites = readList(SITES_KEY);
  const idx = sites.findIndex(s => s.id === siteId);
  if (idx === -1) return { ok: false, error: 'Site not found.' };
  const site = sites[idx];
  if (!isOwner(site.communityId, actorId)) {
    return { ok: false, error: 'Only the owner can archive or restore sites.' };
  }
  const actorName = resolveDisplayName(actorId);
  const next = {
    ...site,
    status,
    updatedAt: Date.now(),
    archivedAt: status === 'archived' ? Date.now() : null,
    archivedById: status === 'archived' ? actorId : null,
    archivedBy: status === 'archived' ? actorName : null,
  };
  sites[idx] = next;
  writeList(SITES_KEY, sites);
  return { ok: true, site: next };
}

// Archiving never touches, cancels, or blocks any existing order — it only
// removes the site from pickers used to start *new* orders (see
// canCreateOrderForSite below and getActiveSitesForUser). All historical
// orders keep their own siteName/siteAddress/sitePostcode snapshot
// regardless of what happens to the live site record afterward.
export function archiveSite(siteId, actorId) {
  return setSiteStatus(siteId, 'archived', actorId);
}

export function restoreSite(siteId, actorId) {
  return setSiteStatus(siteId, 'active', actorId);
}

// --- Membership ---------------------------------------------------------
// Many-to-many by construction: a membership is its own row, not a list
// embedded on either the site or the user — this is what lets one employee
// belong to zero, one, or many sites, and one site have zero, one, or many
// employees, with no 1:1 assumption anywhere.

export function getMemberships(siteId) {
  return readList(MEMBERSHIPS_KEY).filter(m => m.siteId === siteId);
}

export function getSiteMembers(siteId) {
  return Array.from(new Set(getMemberships(siteId).map(m => m.userId)));
}

export function isSiteMember(siteId, userId) {
  if (!siteId || !userId) return false;
  return readList(MEMBERSHIPS_KEY).some(m => m.siteId === siteId && m.userId === userId);
}

// Every site (active or archived) a user belongs to, across every community
// — used to answer "which sites is this employee assigned to" from the
// employee's own point of view.
export function getSitesForMember(userId) {
  if (!userId) return [];
  const memberSiteIds = new Set(
    readList(MEMBERSHIPS_KEY).filter(m => m.userId === userId).map(m => m.siteId)
  );
  return readList(SITES_KEY).filter(s => memberSiteIds.has(s.id));
}

// Active sites within one community that a user is a member of — the exact
// list a worker/buyer picks from. Scoped by communityId explicitly (via
// getActiveSites), so a membership row can never leak a site from a
// different company even if the same user belongs to sites in both.
export function getActiveSitesForUser(communityId, userId) {
  if (!userId) return [];
  const memberSiteIds = new Set(
    readList(MEMBERSHIPS_KEY).filter(m => m.userId === userId).map(m => m.siteId)
  );
  return getActiveSites(communityId).filter(s => memberSiteIds.has(s.id));
}

export function addSiteMember(siteId, userId, actorId) {
  const site = getSite(siteId);
  if (!site) return { ok: false, error: 'Site not found.' };
  if (!isOwner(site.communityId, actorId)) {
    return { ok: false, error: 'Only the owner can assign employees to a site.' };
  }
  if (!isApprovedMember(site.communityId, userId)) {
    return { ok: false, error: 'Only approved members of this community can be assigned to a site.' };
  }
  const memberships = readList(MEMBERSHIPS_KEY);
  if (memberships.some(m => m.siteId === siteId && m.userId === userId)) {
    return { ok: true, alreadyMember: true };
  }
  const actorName = resolveDisplayName(actorId);
  memberships.push({
    id: newId('sm'),
    siteId,
    communityId: site.communityId,
    userId,
    addedAt: Date.now(),
    addedById: actorId,
    addedBy: actorName,
  });
  writeList(MEMBERSHIPS_KEY, memberships);
  return { ok: true };
}

export function removeSiteMember(siteId, userId, actorId) {
  const site = getSite(siteId);
  if (!site) return { ok: false, error: 'Site not found.' };
  if (!isOwner(site.communityId, actorId)) {
    return { ok: false, error: 'Only the owner can remove employees from a site.' };
  }
  const memberships = readList(MEMBERSHIPS_KEY).filter(
    m => !(m.siteId === siteId && m.userId === userId)
  );
  writeList(MEMBERSHIPS_KEY, memberships);
  return { ok: true };
}

// --- Permission composites -----------------------------------------------
// communityId is always an explicit parameter here — never inferred from
// active session state — so a stale/switched active-community pointer can
// never become a security boundary. Owner always bypasses site membership;
// everyone else needs their role-level permission AND site membership,
// never one substituting for the other.
//
// Every check below verifies the site actually exists and belongs to the
// given communityId FIRST, before anything else runs — including the owner
// bypass. A nonexistent siteId, or one belonging to a different community,
// must never return true just because the caller happens to be an owner:
// there is no real site there for them to have access to, so "yes" would be
// a lie regardless of who's asking. This also closes the same cross-company
// gap as before (a site member of Company A's site can't pass a check
// scoped to Company B), just with the existence check now unconditional
// rather than only reached on the non-owner path.
function siteBelongsToCommunity(siteId, communityId) {
  const site = getSite(siteId);
  return !!site && site.communityId === communityId;
}

export function canManageSite(communityId, userId) {
  return isOwner(communityId, userId);
}

export function canAccessSite(siteId, communityId, userId) {
  if (!siteBelongsToCommunity(siteId, communityId)) return false;
  if (isOwner(communityId, userId)) return true;
  return isSiteMember(siteId, userId);
}

export function canCreateOrderForSite(siteId, communityId, userId) {
  if (!siteBelongsToCommunity(siteId, communityId)) return false;
  if (isOwner(communityId, userId)) return true;
  return isApprovedMember(communityId, userId) && isSiteMember(siteId, userId);
}

export function canPurchaseForSite(siteId, communityId, userId) {
  if (!siteBelongsToCommunity(siteId, communityId)) return false;
  if (isOwner(communityId, userId)) return true;
  return isBuyer(communityId, userId) && isSiteMember(siteId, userId);
}
