// Sites (job locations) are now Supabase-backed (Phase 8B) - shared across
// devices, enforced server-side by RLS (see
// supabase/migrations/0009_rls_policies.sql / 0004_sites.sql). Same
// "reference is not permission" discipline as before: every permission
// composite re-derives access from live community/site-membership state,
// never trusts a siteId alone.
//
// CACHE LIFECYCLE - same contract as community.js (read that file's header
// first if you haven't). Every read function here (getSites, getSite,
// canAccessSite, canCreateOrderForSite, canPurchaseForSite,
// getActiveSitesForUser, isSiteMember, getSiteMembers, etc.) stays
// SYNCHRONOUS because orderLifecycle.js and the worker/buyer/owner UI
// modules call them inline inside synchronous render/write code that isn't
// being converted to async this phase. They read an in-memory cache
// (sites/site_memberships) kept fresh by real Supabase traffic. The cache
// is never the authorization boundary - RLS is; a stale cache can at worst
// show a UI affordance a user can no longer use, and the real write is
// independently re-checked server-side regardless.
import { isOwner, isApprovedMember, isBuyer, isPremium } from './community.js';
import { getCurrentUserId, primeProfiles } from './identity.js';
import { subscribeAuth } from './auth.js';
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
    // Product-audit gap fix (migration 0025) - plain nullable date strings
    // ('YYYY-MM-DD'), display-only, never used in any permission/lifecycle
    // decision. Both null means "no project dates set", the pre-existing
    // default behavior for every site created before this existed.
    projectStartDate: r.project_start_date,
    projectEndDate: r.project_end_date,
    // Migration 0027 - site contact + access info, display-only.
    siteContactName: r.site_contact_name || '',
    siteContactPhone: r.site_contact_phone || '',
    accessNotes: r.access_notes || '',
    // Migration 0033 - optional monthly spend cap, hard-enforced server-side
    // by the orders_enforce_site_budget trigger. null = no budget.
    monthlyBudget: r.monthly_budget,
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

// Full refetch of both tables this module owns - see community.js's
// refreshCommunityCache for the full lifecycle explanation (same pattern).
// RLS scopes what actually comes back: an owner sees every site/membership
// in their community; a non-owner only ever sees sites they're personally a
// member of (sites_select's is_site_member branch) - so a worker's cache
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

// Refetches on every auth transition - see community.js's identical
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

// Free/Premium plans (migration 0052). FREE_SITE_LIMIT and the counting
// rule ("every non-archived site counts, archiving frees a slot") mirror
// the sites_enforce_plan_limit DB trigger exactly - these are display-only,
// so createSite/sitesView.js can show the right UI before the write, but
// the real enforcement is server-side and re-checked on every insert/
// restore regardless of what these say.
export const FREE_SITE_LIMIT = 2;

export function sitesUsedTowardLimit(communityId) {
  return getSites(communityId).filter(s => s.status !== 'archived').length;
}

export function canCreateMoreSites(communityId) {
  return isPremium(communityId) || sitesUsedTowardLimit(communityId) < FREE_SITE_LIMIT;
}

// Called synchronously from orderLifecycle.js - must stay sync, cache-backed.
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
    project_start_date: fields.projectStartDate || null,
    project_end_date: fields.projectEndDate || null,
    site_contact_name: (fields.siteContactName || '').trim() || null,
    site_contact_phone: (fields.siteContactPhone || '').trim() || null,
    access_notes: (fields.accessNotes || '').trim() || null,
    monthly_budget: normalizeBudget(fields.monthlyBudget),
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
  if (patch.projectStartDate !== undefined) updates.project_start_date = patch.projectStartDate || null;
  if (patch.projectEndDate !== undefined) updates.project_end_date = patch.projectEndDate || null;
  if (patch.siteContactName !== undefined) updates.site_contact_name = (patch.siteContactName || '').trim() || null;
  if (patch.siteContactPhone !== undefined) updates.site_contact_phone = (patch.siteContactPhone || '').trim() || null;
  if (patch.accessNotes !== undefined) updates.access_notes = (patch.accessNotes || '').trim() || null;
  if (patch.monthlyBudget !== undefined) updates.monthly_budget = normalizeBudget(patch.monthlyBudget);

  const { data, error } = await supabase.from('sites').update(updates).eq('id', siteId).select().single();
  if (error) return { ok: false, error: error.message };
  const mapped = mapSite(data);
  const idx = cache.sites.findIndex(s => s.id === siteId);
  if (idx !== -1) cache.sites[idx] = mapped;
  notify();
  return { ok: true, site: mapped };
}

// '' / null / a non-positive or non-numeric value all mean "no budget".
function normalizeBudget(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const SITE_STATUSES = ['active', 'paused', 'completed', 'archived'];

async function setSiteStatus(siteId, status, actorId) {
  const site = getSite(siteId);
  if (!site) return { ok: false, error: 'Site not found.' };
  if (!SITE_STATUSES.includes(status)) return { ok: false, error: 'Unknown site status.' };
  if (!isOwner(site.communityId, actorId)) {
    return { ok: false, error: 'Only the owner can change a site\'s status.' };
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

// Archiving never touches, cancels, or blocks any existing order - see
// CLAUDE.md's Site model section. Only current members lose anything by an
// archive, so only they get notified.
export async function archiveSite(siteId, actorId) {
  const result = await setSiteStatus(siteId, 'archived', actorId);
  if (result.ok) {
    const { error: notifyError } = await supabase.rpc('notify_site_archived', { p_site_id: siteId });
    if (notifyError) console.error('notify_site_archived failed:', notifyError.message);
  }
  return result;
}

export async function restoreSite(siteId, actorId) {
  return setSiteStatus(siteId, 'active', actorId);
}

// Permanent site deletion (migration 0038) - only for a site that no order
// has ever referenced (the server enforces this; orders.site_id's FK would
// block it anyway). For anything with history, archive is the model.
export async function deleteSite(siteId, actorId) {
  const site = getSite(siteId);
  if (site && !isOwner(site.communityId, actorId)) {
    return { ok: false, error: 'Only the owner can delete a site.' };
  }
  const { error } = await supabase.rpc('delete_site', { p_site_id: siteId });
  if (error) return { ok: false, error: error.message };
  cache.sites = cache.sites.filter(s => s.id !== siteId);
  cache.memberships = cache.memberships.filter(m => m.siteId !== siteId);
  notify();
  return { ok: true };
}

// Migration 0027 - 'paused' (temporarily on hold) and 'completed' (project
// finished) both behave exactly like 'archived' for ordering: getActiveSites
// (and everything that builds on it - the worker site picker, order
// creation) only ever returns status === 'active'. These just give an owner
// a truthful label instead of forcing every non-active site to read as
// "archived". No order lifecycle is affected, same as archive/restore.
export async function changeSiteStatus(siteId, status, actorId) {
  return setSiteStatus(siteId, status, actorId);
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

// Active sites within one community a user is a member of - the exact list
// a worker/buyer picks from. Owner bypass mirrors canAccessSite/
// canCreateOrderForSite/canPurchaseForSite exactly (see CLAUDE.md's Site
// model section for why this bypass exists). Called synchronously from
// site.js's worker order-creation flow - must stay sync, cache-backed.
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
    return { ok: false, error: 'Only approved members of this company can be assigned to a site.' };
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

  const { error: notifyError } = await supabase.rpc('notify_site_member_added', { p_site_id: siteId, p_recipient_id: userId });
  if (notifyError) console.error('notify_site_member_added failed:', notifyError.message);
  return { ok: true };
}

// Bulk employee assignment (product-audit gap fix) - assigns several
// approved members to a site in one round trip instead of one addSiteMember
// call per person. Genuinely bulk (a single insert, not a client-side loop
// over addSiteMember): a loop would mean a partial failure silently leaves
// some members assigned and others not with no way to tell the caller which
// succeeded, whereas one insert either adds everyone requested or reports
// one clear error. Members already assigned or not eligible are simply
// skipped rather than failing the whole batch - same "already a member is a
// no-op, not an error" rule addSiteMember already applies, just batched.
export async function addSiteMembers(siteId, userIds, actorId) {
  const site = getSite(siteId);
  if (!site) return { ok: false, error: 'Site not found.' };
  if (!isOwner(site.communityId, actorId)) {
    return { ok: false, error: 'Only the owner can assign employees to a site.' };
  }
  const eligible = Array.from(new Set(userIds)).filter(
    userId => isApprovedMember(site.communityId, userId) && !isSiteMember(siteId, userId)
  );
  if (eligible.length === 0) {
    return { ok: true, addedCount: 0 };
  }
  const { data, error } = await supabase.from('site_memberships').insert(
    eligible.map(userId => ({
      site_id: siteId,
      community_id: site.communityId,
      user_id: userId,
      added_by_id: actorId,
    }))
  ).select();
  if (error) return { ok: false, error: error.message };
  cache.memberships.push(...data.map(mapMembership));
  notify();

  await Promise.all(eligible.map(async userId => {
    const { error: notifyError } = await supabase.rpc('notify_site_member_added', { p_site_id: siteId, p_recipient_id: userId });
    if (notifyError) console.error('notify_site_member_added failed:', notifyError.message);
  }));
  return { ok: true, addedCount: eligible.length };
}

// The transpose of addSiteMembers: one member, several sites, in one insert
// instead of a client-side loop over addSiteMember. Used when a join request
// is approved with sites pre-ticked (owner.js) - that used to fire one
// addSiteMember round trip per checked site. Same "already assigned / not
// eligible is skipped, not an error" rule as addSiteMembers. All sites must
// belong to one company (owner.js only ever passes sites from the community
// it is rendering; re-checked here).
export async function addMemberToSites(userId, siteIds, actorId) {
  const sites = Array.from(new Set(siteIds)).map(getSite).filter(Boolean);
  if (sites.length === 0) return { ok: true, addedCount: 0 };
  const communityId = sites[0].communityId;
  if (sites.some(s => s.communityId !== communityId)) {
    return { ok: false, error: 'Those sites are not all in the same company.' };
  }
  if (!isOwner(communityId, actorId)) {
    return { ok: false, error: 'Only the owner can assign employees to a site.' };
  }
  if (!isApprovedMember(communityId, userId)) {
    return { ok: false, error: 'Only approved members of this company can be assigned to a site.' };
  }
  const targets = sites.filter(s => !isSiteMember(s.id, userId));
  if (targets.length === 0) return { ok: true, addedCount: 0 };
  const { data, error } = await supabase.from('site_memberships').insert(
    targets.map(s => ({
      site_id: s.id,
      community_id: s.communityId,
      user_id: userId,
      added_by_id: actorId,
    }))
  ).select();
  if (error) return { ok: false, error: error.message };
  cache.memberships.push(...data.map(mapMembership));
  notify();

  await Promise.all(targets.map(async s => {
    const { error: notifyError } = await supabase.rpc('notify_site_member_added', { p_site_id: s.id, p_recipient_id: userId });
    if (notifyError) console.error('notify_site_member_added failed:', notifyError.message);
  }));
  return { ok: true, addedCount: targets.length };
}

// Phase 8D.1 hardening (0015): the removal and its notification are now one
// atomic server-side operation (remove_site_member RPC) - the database
// itself proves a real membership existed before any notification is
// created, rather than a client delete followed by a separately-trusted
// notify call. The isOwner check below stays as a client-side fast-fail for
// UX (avoids a round trip for an obviously-unauthorized attempt); the RPC's
// own is_owner + existence checks are the real, non-bypassable boundary.
// See 0015_revoke_remove_notification_integrity.sql for the full rationale.
export async function removeSiteMember(siteId, userId, actorId) {
  const site = getSite(siteId);
  if (!site) return { ok: false, error: 'Site not found.' };
  if (!isOwner(site.communityId, actorId)) {
    return { ok: false, error: 'Only the owner can remove employees from a site.' };
  }
  const { error } = await supabase.rpc('remove_site_member', { p_site_id: siteId, p_recipient_id: userId });
  if (error) return { ok: false, error: error.message };
  cache.memberships = cache.memberships.filter(m => !(m.siteId === siteId && m.userId === userId));
  notify();
  return { ok: true };
}

// --- Permission composites -----------------------------------------------
// Every check below verifies the site actually exists and belongs to the
// given communityId FIRST - see CLAUDE.md's Site model section. The
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

// Called synchronously from buyer.js/site.js/main.js - must stay sync.
export function canAccessSite(siteId, communityId, userId) {
  if (!siteBelongsToCommunity(siteId, communityId)) return false;
  if (isOwner(communityId, userId)) return true;
  return isSiteMember(siteId, userId);
}

// Called synchronously from orderLifecycle.js - must stay sync, cache-backed.
export function canCreateOrderForSite(siteId, communityId, userId) {
  if (!siteBelongsToCommunity(siteId, communityId)) return false;
  if (isOwner(communityId, userId)) return true;
  return isApprovedMember(communityId, userId) && isSiteMember(siteId, userId);
}

// Called synchronously from orderLifecycle.js - must stay sync, cache-backed.
// Mirrors migration 0023's can_purchase_for_site: the non-owner branch also
// requires an approved membership, so a suspended member's dormant buyer
// grant can't purchase. (isBuyer already folds in isApprovedMember since
// Phase C, so this is belt-and-braces + explicit.)
export function canPurchaseForSite(siteId, communityId, userId) {
  if (!siteBelongsToCommunity(siteId, communityId)) return false;
  if (isOwner(communityId, userId)) return true;
  return isApprovedMember(communityId, userId) && isBuyer(communityId, userId) && isSiteMember(siteId, userId);
}
