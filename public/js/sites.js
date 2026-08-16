// Sites (job locations) are now Supabase-backed (Phase 8B) — shared across
// devices, enforced server-side by RLS (see
// supabase/migrations/0009_rls_policies.sql / 0004_sites.sql). Same
// "reference is not permission" discipline as before: every permission
// composite re-derives access from live community/site-membership state,
// never trusts a siteId alone.
//
// CACHE LIFECYCLE — same contract as community.js (read that file's header
// first if you haven't). Every read function here (getSites, getSite,
// canAccessSite, canCreateOrderForSite, canPurchaseForSite,
// getActiveSitesForUser, isSiteMember, getSiteMembers, etc.) stays
// SYNCHRONOUS because orderLifecycle.js and the worker/buyer/owner UI
// modules call them inline inside synchronous render/write code that isn't
// being converted to async this phase. They read an in-memory cache
// (sites/site_memberships) kept fresh by real Supabase traffic. The cache
// is never the authorization boundary — RLS is; a stale cache can at worst
// show a UI affordance a user can no longer use, and the real write is
// independently re-checked server-side regardless.
import { isOwner, isApprovedMember, isBuyer } from './community.js';
import { getCurrentUserId, primeProfiles, resolveDisplayName } from './identity.js';
import { subscribeAuth } from './auth.js';
import { notifyUsers } from './notifications.js';
import { supabase } from './supabaseClient.js';

const listeners = new Set();
function notify() {
  listeners.forEach(fn => fn());
}

export function subscribeSites(fn) {
  listeners.add(fn);
  fn();
  return () => listeners.delete(fn);
}

// --- Cache ----------------------------------------------------------
let cache = { sites: [], memberships: [] };
export let sitesCacheReady = false;

function mapSite(r) {
  return {
    id: r.id,
    communityId: r.community_id,
    name: r.name,
    address: r.address || '',
    postcode: r.postcode || '',
    deliveryInstructions: r.delivery_instructions || '',
    status: r.status,
    createdAt: new Date(r.created_at).getTime(),
    createdById: r.created_by_id,
    updatedAt: new Date(r.updated_at).getTime(),
    archivedAt: r.archived_at ? new Date(r.archived_at).getTime() : null,
    archivedById: r.archived_by_id,
  };
}

function mapMembership(r) {
  return {
    id: r.id,
    siteId: r.site_id,
    communityId: r.community_id,
    userId: r.user_id,
    addedById: r.added_by_id,
    addedAt: new Date(r.added_at).getTime(),
  };
}

// Full refetch of both tables this module owns — see community.js's
// refreshCommunityCache for the full lifecycle explanation (same pattern).
// RLS scopes what actually comes back: an owner sees every site/membership
// in their community; a non-owner only ever sees sites they're personally a
// member of (sites_select's is_site_member branch) — so a worker's cache
// never even contains a site they shouldn't see in the first place. The
// explicit membership filtering below is kept anyway (not relied-on-RLS-
// alone) so this file's own logic stays identical to the pre-Phase-8B
// behavior and easy to audit side by side.
export async function refreshSitesCache() {
  const userId = getCurrentUserId();
  if (!userId) {
    cache = { sites: [], memberships: [] };
    sitesCacheReady = true;
    notify();
    return;
  }
  const [sitesRes, membershipsRes] = await Promise.all([
    supabase.from('sites').select('*'),
    supabase.from('site_memberships').select('*'),
  ]);
  cache = {
    sites: (sitesRes.data || []).map(mapSite),
    memberships: (membershipsRes.data || []).map(mapMembership),
  };
  sitesCacheReady = true;

  const ids = new Set();
  cache.sites.forEach(s => {
    ids.add(s.createdById);
    if (s.archivedById) ids.add(s.archivedById);
  });
  cache.memberships.forEach(m => {
    ids.add(m.userId);
    ids.add(m.addedById);
  });
  if (ids.size > 0) {
    const { data } = await supabase.from('profiles').select('id, display_name').in('id', Array.from(ids));
    if (data) primeProfiles(data);
  }

  notify();
}

// Refetches on every auth transition — see community.js's identical
// subscription for why this is in addition to, not instead of, main.js's
// explicit bootstrap await.
subscribeAuth(() => { refreshSitesCache(); });

// --- Site CRUD --------------------------------------------------------

export function getSites(communityId) {
  return cache.sites.filter(s => s.communityId === communityId);
}

export function getActiveSites(communityId) {
  return getSites(communityId).filter(s => s.status === 'active');
}

// Called synchronously from orderLifecycle.js — must stay sync, cache-backed.
export function getSite(siteId) {
  return cache.sites.find(s => s.id === siteId) || null;
}

export async function createSite(communityId, fields, actorId) {
  if (!isOwner(communityId, actorId)) {
    return { ok: false, error: 'Only the owner can create sites.' };
  }
  const name = (fields.name || '').trim();
  if (!name) {
    return { ok: false, error: 'Site name is required.' };
  }
  const { data, error } = await supabase.from('sites').insert({
    community_id: communityId,
    name,
    address: (fields.address || '').trim(),
    postcode: (fields.postcode || '').trim(),
    delivery_instructions: (fields.deliveryInstructions || '').trim(),
    created_by_id: actorId,
  }).select().single();
  if (error) return { ok: false, error: error.message };
  const site = mapSite(data);
  cache.sites.push(site);
  notify();
  return { ok: true, site };
}

export async function updateSite(siteId, patch, actorId) {
  const site = getSite(siteId);
  if (!site) return { ok: false, error: 'Site not found.' };
  if (!isOwner(site.communityId, actorId)) {
    return { ok: false, error: 'Only the owner can edit sites.' };
  }
  const updates = { updated_at: new Date().toISOString() };
  if (patch.name !== undefined) {
    const trimmed = patch.name.trim();
    if (!trimmed) return { ok: false, error: 'Site name is required.' };
    updates.name = trimmed;
  }
  if (patch.address !== undefined) updates.address = (patch.address || '').trim();
  if (patch.postcode !== undefined) updates.postcode = (patch.postcode || '').trim();
  if (patch.deliveryInstructions !== undefined) updates.delivery_instructions = (patch.deliveryInstructions || '').trim();

  const { data, error } = await supabase.from('sites').update(updates).eq('id', siteId).select().single();
  if (error) return { ok: false, error: error.message };
  const mapped = mapSite(data);
  const idx = cache.sites.findIndex(s => s.id === siteId);
  if (idx !== -1) cache.sites[idx] = mapped;
  notify();
  return { ok: true, site: mapped };
}

async function setSiteStatus(siteId, status, actorId) {
  const site = getSite(siteId);
  if (!site) return { ok: false, error: 'Site not found.' };
  if (!isOwner(site.communityId, actorId)) {
    return { ok: false, error: 'Only the owner can archive or restore sites.' };
  }
  const nowIso = new Date().toISOString();
  const updates = {
    status,
    updated_at: nowIso,
    archived_at: status === 'archived' ? nowIso : null,
    archived_by_id: status === 'archived' ? actorId : null,
  };
  const { data, error } = await supabase.from('sites').update(updates).eq('id', siteId).select().single();
  if (error) return { ok: false, error: error.message };
  const mapped = mapSite(data);
  const idx = cache.sites.findIndex(s => s.id === siteId);
  if (idx !== -1) cache.sites[idx] = mapped;
  notify();
  return { ok: true, site: mapped };
}

// Archiving never touches, cancels, or blocks any existing order — see
// CLAUDE.md's Site model section. Only current members lose anything by an
// archive, so only they get notified.
export async function archiveSite(siteId, actorId) {
  const result = await setSiteStatus(siteId, 'archived', actorId);
  if (result.ok) {
    const memberIds = getSiteMembers(siteId);
    if (memberIds.length > 0) {
      const actorName = resolveDisplayName(actorId);
      notifyUsers(memberIds, {
        type: 'site_archived',
        title: 'Site archived',
        message: `${actorName} archived ${result.site.name}. You can no longer create new orders for it.`,
        communityId: result.site.communityId,
        siteId: result.site.id,
        actorId,
        actorName,
        navigationTarget: { communityId: result.site.communityId, role: 'worker', siteId: result.site.id },
      });
    }
  }
  return result;
}

export async function restoreSite(siteId, actorId) {
  return setSiteStatus(siteId, 'active', actorId);
}

// --- Membership ---------------------------------------------------------

export function getMemberships(siteId) {
  return cache.memberships.filter(m => m.siteId === siteId);
}

export function getSiteMembers(siteId) {
  return Array.from(new Set(getMemberships(siteId).map(m => m.userId)));
}

export function isSiteMember(siteId, userId) {
  if (!siteId || !userId) return false;
  return cache.memberships.some(m => m.siteId === siteId && m.userId === userId);
}

export function getSitesForMember(userId) {
  if (!userId) return [];
  const memberSiteIds = new Set(cache.memberships.filter(m => m.userId === userId).map(m => m.siteId));
  return cache.sites.filter(s => memberSiteIds.has(s.id));
}

// Active sites within one community a user is a member of — the exact list
// a worker/buyer picks from. Owner bypass mirrors canAccessSite/
// canCreateOrderForSite/canPurchaseForSite exactly (see CLAUDE.md's Site
// model section for why this bypass exists). Called synchronously from
// site.js's worker order-creation flow — must stay sync, cache-backed.
export function getActiveSitesForUser(communityId, userId) {
  if (!userId) return [];
  if (isOwner(communityId, userId)) return getActiveSites(communityId);
  const memberSiteIds = new Set(cache.memberships.filter(m => m.userId === userId).map(m => m.siteId));
  return getActiveSites(communityId).filter(s => memberSiteIds.has(s.id));
}

export async function addSiteMember(siteId, userId, actorId) {
  const site = getSite(siteId);
  if (!site) return { ok: false, error: 'Site not found.' };
  if (!isOwner(site.communityId, actorId)) {
    return { ok: false, error: 'Only the owner can assign employees to a site.' };
  }
  if (!isApprovedMember(site.communityId, userId)) {
    return { ok: false, error: 'Only approved members of this community can be assigned to a site.' };
  }
  if (cache.memberships.some(m => m.siteId === siteId && m.userId === userId)) {
    return { ok: true, alreadyMember: true };
  }
  const { data, error } = await supabase.from('site_memberships').insert({
    site_id: siteId,
    community_id: site.communityId,
    user_id: userId,
    added_by_id: actorId,
  }).select().single();
  if (error) return { ok: false, error: error.message };
  cache.memberships.push(mapMembership(data));
  notify();

  const actorName = resolveDisplayName(actorId);
  notifyUsers([userId], {
    type: 'site_member_added',
    title: 'Added to a site',
    message: `${actorName} added you to ${site.name}.`,
    communityId: site.communityId,
    siteId: site.id,
    actorId,
    actorName,
    navigationTarget: { communityId: site.communityId, role: 'worker', siteId: site.id },
  });

  return { ok: true };
}

export async function removeSiteMember(siteId, userId, actorId) {
  const site = getSite(siteId);
  if (!site) return { ok: false, error: 'Site not found.' };
  if (!isOwner(site.communityId, actorId)) {
    return { ok: false, error: 'Only the owner can remove employees from a site.' };
  }
  const wasMember = isSiteMember(siteId, userId);
  const { error } = await supabase.from('site_memberships').delete()
    .eq('site_id', siteId).eq('user_id', userId);
  if (error) return { ok: false, error: error.message };
  cache.memberships = cache.memberships.filter(m => !(m.siteId === siteId && m.userId === userId));
  notify();

  if (wasMember) {
    const actorName = resolveDisplayName(actorId);
    notifyUsers([userId], {
      type: 'site_member_removed',
      title: 'Removed from a site',
      message: `${actorName} removed you from ${site.name}.`,
      communityId: site.communityId,
      siteId: site.id,
      actorId,
      actorName,
      navigationTarget: { communityId: site.communityId, role: 'worker', siteId: site.id },
    });
  }

  return { ok: true };
}

// --- Permission composites -----------------------------------------------
// Every check below verifies the site actually exists and belongs to the
// given communityId FIRST — see CLAUDE.md's Site model section. The
// (site_id, community_id) composite foreign key in migrations/0004_sites.sql
// makes the underlying data invariant impossible to violate server-side;
// this is the second, independent client-side layer on top of that, kept
// identical to the pre-Phase-8B logic.
function siteBelongsToCommunity(siteId, communityId) {
  const site = getSite(siteId);
  return !!site && site.communityId === communityId;
}

export function canManageSite(communityId, userId) {
  return isOwner(communityId, userId);
}

// Called synchronously from buyer.js/site.js/main.js — must stay sync.
export function canAccessSite(siteId, communityId, userId) {
  if (!siteBelongsToCommunity(siteId, communityId)) return false;
  if (isOwner(communityId, userId)) return true;
  return isSiteMember(siteId, userId);
}

// Called synchronously from orderLifecycle.js — must stay sync, cache-backed.
export function canCreateOrderForSite(siteId, communityId, userId) {
  if (!siteBelongsToCommunity(siteId, communityId)) return false;
  if (isOwner(communityId, userId)) return true;
  return isApprovedMember(communityId, userId) && isSiteMember(siteId, userId);
}

// Called synchronously from orderLifecycle.js — must stay sync, cache-backed.
export function canPurchaseForSite(siteId, communityId, userId) {
  if (!siteBelongsToCommunity(siteId, communityId)) return false;
  if (isOwner(communityId, userId)) return true;
  return isBuyer(communityId, userId) && isSiteMember(siteId, userId);
}
