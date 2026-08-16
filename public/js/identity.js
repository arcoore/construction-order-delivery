// The seam between the current Supabase session (auth.js) and everyone
// else's "who is the current user" question. As of Phase 8B this is a real
// account only — the old anonymous "Skip for now" guest system has been
// removed entirely (see PROGRESS.md's Phase 8B section). Nothing short of
// a real Supabase sign-in can change which permissions a user id holds.
//
// getCurrentUserId()/getCurrentDisplayName()/resolveDisplayName() are kept
// SYNCHRONOUS on purpose — orderLifecycle.js and the owner/buyer/driver/site
// UI modules all call them inline inside synchronous render code, and none
// of those are being converted to async this phase (see CLAUDE.md's Phase
// 8B section for the full reasoning). The real Supabase reads happen behind
// the scenes; these functions read an in-memory cache that's kept fresh by
// that traffic, never by pretending a network call is instant.
import { getLoggedInAccount, subscribeAuth } from './auth.js';
import { supabase } from './supabaseClient.js';

const listeners = new Set();
function notify() {
  listeners.forEach(fn => fn());
}

export function subscribeIdentity(fn) {
  listeners.add(fn);
  fn();
  return () => listeners.delete(fn);
}

subscribeAuth(notify);

export function getCurrentUserId() {
  const account = getLoggedInAccount();
  return account ? account.id : null;
}

export function getCurrentDisplayName() {
  const account = getLoggedInAccount();
  return account ? account.displayName : '';
}

// --- Other users' display names: profiles table, cached ------------------
// Self is answered straight from the live session (always correct, no
// fetch needed) — this cache exists only for resolving OTHER users' ids.

const profileCache = new Map(); // userId -> displayName
const inFlight = new Set(); // userIds currently being fetched, to dedupe

async function fetchProfile(userId) {
  if (inFlight.has(userId)) return;
  inFlight.add(userId);
  try {
    const { data, error } = await supabase.from('profiles').select('id, display_name').eq('id', userId).maybeSingle();
    if (!error && data) {
      profileCache.set(data.id, data.display_name);
      notify();
    }
  } finally {
    inFlight.delete(userId);
  }
}

// Bulk-seeds the cache from a query community.js/sites.js already ran for
// their own purposes (e.g. a join against profiles) — avoids a separate
// fetch per id when a caller already has the rows in hand. Safe to call
// with an empty/partial list; never overwrites with stale data since every
// entry here came from a query that just ran.
export function primeProfiles(rows) {
  let changed = false;
  for (const row of rows || []) {
    if (row && row.id && typeof row.display_name === 'string') {
      profileCache.set(row.id, row.display_name);
      changed = true;
    }
  }
  if (changed) notify();
}

// Loads every known profile once — cheap at this app's scale (a prototype's
// worth of accounts, not a real user base), and avoids an individual fetch
// for every name the UI happens to render first. Called from main.js's
// bootstrap and safe to call again any time a full refresh is wanted.
export async function loadAllProfiles() {
  if (!getCurrentUserId()) return; // no session yet — RLS would refuse this anyway (no anon grant on profiles)
  const { data, error } = await supabase.from('profiles').select('id, display_name');
  if (!error && data) primeProfiles(data);
}

// Resolves a stored user id back into a readable name, for "current state"
// UI (community owner label, team panel) rather than a point-in-time
// snapshot. Synchronous by contract (see file header) — a cache miss kicks
// off a background fetch and returns the same 'Unknown' fallback the old
// guest-lookup path used for a name it didn't recognize yet; the next
// render (triggered by notify() once the fetch resolves) shows the real
// name.
export function resolveDisplayName(userId) {
  if (!userId) return 'Unknown';
  if (userId === getCurrentUserId()) return getCurrentDisplayName() || 'Unknown';
  if (profileCache.has(userId)) return profileCache.get(userId) || 'Unknown';
  fetchProfile(userId);
  return 'Unknown';
}
