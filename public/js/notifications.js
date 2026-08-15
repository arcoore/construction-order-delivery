// The single storage/read-state owner for in-app notifications. UI code must
// never touch sitestock_notifications_v1 or sitestock_notification_prefs_v1
// directly — everything goes through this module, exactly like store.js/
// community.js own their respective storage.
//
// recipientUserId is the only field ever used to decide "is this mine" —
// never a display name (see identity.js). actorName is a cosmetic snapshot
// only, mirroring orderLifecycle.js's event log.
//
// This module is a leaf: it knows nothing about orders, communities, or
// permissions. Callers (orderLifecycle.js, community.js) compute recipient
// user ids themselves using community.js's existing permission functions,
// and pass fully-formed, role-appropriate title/message text in — that's
// what keeps driver-facing content free of prices: the caller decides what
// each recipient is allowed to see, this module just stores and routes it.
const NOTIFS_KEY = 'sitestock_notifications_v1';
const PREFS_KEY = 'sitestock_notification_prefs_v1';

// Every notification type's category (for preference filtering) and whether
// it can be muted at all. buyer_access_granted/revoked are non-configurable
// because they directly affect the recipient's own permissions.
const NOTIFICATION_TYPES = {
  order_awaiting_approval: { category: 'approvalUpdates', configurable: true },
  order_rejected: { category: 'approvalUpdates', configurable: true },
  approval_reverted: { category: 'approvalUpdates', configurable: true },
  order_ready_for_purchase: { category: 'orderUpdates', configurable: true },
  delivery_available: { category: 'deliveryUpdates', configurable: true, subKey: 'deliveryAvailableEnabled' },
  delivery_claimed: { category: 'deliveryUpdates', configurable: true, subKey: 'deliveryClaimedEnabled' },
  delivery_cancelled: { category: 'deliveryUpdates', configurable: true },
  delivery_collected: { category: 'deliveryUpdates', configurable: true, subKey: 'deliveryCollectedEnabled' },
  order_delivered: { category: 'deliveryUpdates', configurable: true },
  buyer_access_requested: { category: 'roleUpdates', configurable: true },
  buyer_access_granted: { category: 'roleUpdates', configurable: false },
  buyer_access_rejected: { category: 'roleUpdates', configurable: true },
  buyer_access_revoked: { category: 'roleUpdates', configurable: false },
  // Site membership/archive changes directly affect what the recipient can
  // create orders for or purchase, exactly like buyer access above — same
  // non-configurable treatment, same reasoning, same category.
  site_member_added: { category: 'roleUpdates', configurable: false },
  site_member_removed: { category: 'roleUpdates', configurable: false },
  site_archived: { category: 'roleUpdates', configurable: false },
  // Phase 7B — Worker corrections & cancellation. All three are ordinary,
  // configurable orderUpdates: unlike the role/permission-change types
  // above, nothing here changes what the recipient is allowed to do, so
  // there's no reason to force them on.
  cancellation_requested: { category: 'orderUpdates', configurable: true },
  cancellation_approved: { category: 'orderUpdates', configurable: true },
  cancellation_rejected: { category: 'orderUpdates', configurable: true },
};

// Delivery updates deliberately has mixed defaults within one category
// (cancelled/delivered default ON, the three "routine" ones default OFF) —
// that's why those three get their own subKey above and their own default
// here, rather than everything just inheriting the category's default.
const DEFAULT_PREFS = {
  orderUpdates: true,
  approvalUpdates: true,
  deliveryUpdates: true,
  roleUpdates: true,
  deliveryAvailableEnabled: false,
  deliveryClaimedEnabled: false,
  deliveryCollectedEnabled: false,
};

function readNotifs() {
  try {
    const raw = localStorage.getItem(NOTIFS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function writeNotifs(list) {
  localStorage.setItem(NOTIFS_KEY, JSON.stringify(list));
  notify();
}

function readPrefsList() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function writePrefsList(list) {
  localStorage.setItem(PREFS_KEY, JSON.stringify(list));
  notifyPrefs();
}

const listeners = new Set();
function notify() {
  const all = readNotifs();
  listeners.forEach(fn => fn(all));
}

const prefsListeners = new Set();
function notifyPrefs() {
  prefsListeners.forEach(fn => fn());
}

window.addEventListener('storage', e => {
  if (e.key === NOTIFS_KEY) notify();
  if (e.key === PREFS_KEY) notifyPrefs();
});

export function subscribeNotifications(fn) {
  listeners.add(fn);
  fn(readNotifs());
  return () => listeners.delete(fn);
}

export function subscribeNotificationPreferences(fn) {
  prefsListeners.add(fn);
  fn();
  return () => prefsListeners.delete(fn);
}

function newId() {
  return crypto.randomUUID ? crypto.randomUUID() : `notif-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function getPreferences(userId) {
  const rec = readPrefsList().find(p => p.userId === userId);
  return rec ? { ...DEFAULT_PREFS, ...rec } : { ...DEFAULT_PREFS };
}

export function savePreferences(userId, prefs) {
  const list = readPrefsList();
  const idx = list.findIndex(p => p.userId === userId);
  const record = { ...DEFAULT_PREFS, ...prefs, userId, updatedAt: Date.now() };
  if (idx === -1) list.push(record); else list[idx] = record;
  writePrefsList(list);
}

// Creation-time filtering: if a category (or sub-switch) is off, the
// notification is simply never written for that recipient. Turning the
// preference back on later does not retroactively create what was missed —
// there is nothing to "reveal," which is the deliberate, simpler behaviour.
function isTypeEnabledFor(userId, type) {
  const meta = NOTIFICATION_TYPES[type];
  if (!meta || !meta.configurable) return true;
  const prefs = getPreferences(userId);
  if (prefs[meta.category] === false) return false;
  if (meta.subKey) return prefs[meta.subKey] !== false;
  return true;
}

// The single write path. Recipients are computed by the caller using
// community.js's own permission functions — this module stays a leaf, no
// permission logic lives here. The acting user is always excluded, even if
// they'd otherwise be in the recipient list (no self-notifications).
export function notifyUsers(recipientUserIds, {
  type, title, message, communityId = null, orderId = null, requestId = null,
  eventId = null, siteId = null, actorId = null, actorName = null, navigationTarget = null,
}) {
  const uniqueRecipients = Array.from(new Set((recipientUserIds || []).filter(Boolean)));
  const notifs = readNotifs();
  let changed = false;
  uniqueRecipients.forEach(recipientUserId => {
    if (recipientUserId === actorId) return;
    if (!isTypeEnabledFor(recipientUserId, type)) return;
    notifs.push({
      id: newId(),
      recipientUserId,
      type,
      category: NOTIFICATION_TYPES[type]?.category ?? null,
      title,
      message,
      communityId,
      orderId,
      requestId,
      eventId,
      siteId,
      actorId,
      actorName,
      navigationTarget,
      createdAt: Date.now(),
      read: false,
      readAt: null,
    });
    changed = true;
  });
  if (changed) writeNotifs(notifs);
}

export function getNotificationsFor(userId) {
  return readNotifs().filter(n => n.recipientUserId === userId).sort((a, b) => b.createdAt - a.createdAt);
}

export function getUnreadCount(userId) {
  return readNotifs().filter(n => n.recipientUserId === userId && !n.read).length;
}

export function markRead(id) {
  const notifs = readNotifs();
  const idx = notifs.findIndex(n => n.id === id);
  if (idx === -1) return;
  notifs[idx] = { ...notifs[idx], read: true, readAt: Date.now() };
  writeNotifs(notifs);
}

export function markUnread(id) {
  const notifs = readNotifs();
  const idx = notifs.findIndex(n => n.id === id);
  if (idx === -1) return;
  notifs[idx] = { ...notifs[idx], read: false, readAt: null };
  writeNotifs(notifs);
}

// Only ever touches rows already filtered to this userId — there is no
// broader set for it to reach, by construction of the query itself.
export function markAllRead(userId) {
  const notifs = readNotifs();
  let changed = false;
  const updated = notifs.map(n => {
    if (n.recipientUserId === userId && !n.read) {
      changed = true;
      return { ...n, read: true, readAt: Date.now() };
    }
    return n;
  });
  if (changed) writeNotifs(updated);
}
