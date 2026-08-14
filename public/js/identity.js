// The seam between real accounts (auth.js) and anonymous "skip for now"
// sessions. Everything else in the app should ask this module "who is the
// current user" rather than touching localStorage identity state directly.
//
// The key property this module guarantees: the value returned by
// getCurrentUserId() is stable and unique per browser session, and nothing
// short of actually logging into an account can change which permissions it
// holds. Typing a display name only ever relabels that fixed id — it can
// never grant someone else's access.
import { getLoggedInAccount, findAccountById, subscribeAuth } from './auth.js';

const GUEST_ID_KEY = 'sitestock_guest_id_v1';
const GUEST_NAMES_KEY = 'sitestock_guest_names_v1';

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

window.addEventListener('storage', e => {
  if (e.key === GUEST_ID_KEY || e.key === GUEST_NAMES_KEY) notify();
});

function newGuestId() {
  return crypto.randomUUID ? crypto.randomUUID() : `guest-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function readGuestNames() {
  try {
    const raw = localStorage.getItem(GUEST_NAMES_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeGuestNames(map) {
  localStorage.setItem(GUEST_NAMES_KEY, JSON.stringify(map));
}

export function getGuestId() {
  let id = localStorage.getItem(GUEST_ID_KEY);
  if (!id) {
    id = newGuestId();
    localStorage.setItem(GUEST_ID_KEY, id);
  }
  return id;
}

// Starts a brand-new, unrelated guest identity in this browser. The old
// guest id keeps whatever community/order data and display name it already
// had (so historical records still resolve to a readable name) — this
// browser just stops acting as that guest going forward.
export function newGuestIdentity() {
  localStorage.setItem(GUEST_ID_KEY, newGuestId());
  notify();
}

export function getGuestName() {
  return readGuestNames()[getGuestId()] || '';
}

export function setGuestName(name) {
  const map = readGuestNames();
  map[getGuestId()] = (name || '').trim();
  writeGuestNames(map);
  notify();
}

export function isGuest() {
  return !getLoggedInAccount();
}

export function getCurrentUserId() {
  const account = getLoggedInAccount();
  return account ? account.id : getGuestId();
}

export function getCurrentDisplayName() {
  const account = getLoggedInAccount();
  return account ? account.displayName : getGuestName();
}

// Resolves a stored user id back into a readable name, for "current state"
// UI (community owner label, team panel) rather than a point-in-time
// snapshot. Falls back to 'Unknown' if the id belongs to neither a known
// account nor a guest this browser has ever seen.
export function resolveDisplayName(userId) {
  if (!userId) return 'Unknown';
  const account = findAccountById(userId);
  if (account) return account.displayName;
  return readGuestNames()[userId] || 'Unknown';
}
