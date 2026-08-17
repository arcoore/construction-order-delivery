// Phase 8D.1 — notifications and notification preferences are now real
// Supabase tables (`notifications`, `notification_preferences`; RLS-enforced
// — see supabase/migrations/0007_notifications.sql / 0009_rls_policies.sql /
// 0014_notifications_backend.sql), following the exact synchronous-facade-
// over-async-cache pattern community.js/sites.js/orderLifecycle.js already
// established: reads (getNotificationsFor, getUnreadCount, getPreferences)
// stay SYNCHRONOUS over an in-memory cache — main.js's notification bell/
// panel/prefs-modal render code calls these inline, unconverted; every
// write (markRead, markUnread, markAllRead, savePreferences) is genuinely
// `async`.
//
// CREATION IS NO LONGER A CLIENT-SIDE OPERATION. There is no `notifyUsers`
// export anymore, and no INSERT grant on `notifications` for `authenticated`
// at all (see 0007's original comment: "notifications are always a system-
// generated side effect" — 0014 is the writer that comment always intended).
// Every notification is created server-side: order-lifecycle notifications
// are appended inside the existing order-lifecycle RPCs in the same
// transaction as their order_events insert (orderLifecycle.js calls those
// RPCs already, for the state change itself — it does not additionally call
// anything here to also get a notification, the RPC already did it); the
// seven non-order types (buyer access, site membership/archive) are created
// by seven narrow `notify_*` RPCs that community.js/sites.js call directly
// via `supabase.rpc(...)` immediately after their own already-authorized
// direct table write succeeds — see this module's header history (this
// comment block) if a future phase considers adding a client notification
// path again: don't reintroduce a generic client-side notification writer,
// the whole point of 0014 was closing that exact gap.
//
// recipientUserId is still the only field ever used to decide "is this
// mine" — never a display name (see identity.js) — RLS now enforces this as
// a real security boundary too, not just an app-level convention.
import { getCurrentUserId } from './identity.js';
import { subscribeAuth } from './auth.js';
import { supabase } from './supabaseClient.js';

const DEFAULT_PREFS = {
  orderUpdates: true,
  approvalUpdates: true,
  deliveryUpdates: true,
  roleUpdates: true,
  deliveryAvailableEnabled: false,
  deliveryClaimedEnabled: false,
  deliveryCollectedEnabled: false,
};

function mapNotificationRow(r) {
  return {
    id: r.id,
    recipientUserId: r.recipient_user_id,
    type: r.type,
    category: r.category,
    title: r.title,
    message: r.message,
    communityId: r.community_id,
    orderId: r.order_id,
    requestId: r.request_id,
    eventId: r.event_id,
    siteId: r.site_id,
    actorId: r.actor_id,
    actorName: r.actor_name,
    navigationTarget: r.navigation_target,
    createdAt: new Date(r.created_at).getTime(),
    read: r.read,
    readAt: r.read_at ? new Date(r.read_at).getTime() : null,
  };
}

function mapPrefsRow(r) {
  return {
    orderUpdates: r.order_updates,
    approvalUpdates: r.approval_updates,
    deliveryUpdates: r.delivery_updates,
    roleUpdates: r.role_updates,
    deliveryAvailableEnabled: r.delivery_available_enabled,
    deliveryClaimedEnabled: r.delivery_claimed_enabled,
    deliveryCollectedEnabled: r.delivery_collected_enabled,
  };
}

function prefsPatchToRow(patch) {
  const row = {};
  if (patch.orderUpdates !== undefined) row.order_updates = patch.orderUpdates;
  if (patch.approvalUpdates !== undefined) row.approval_updates = patch.approvalUpdates;
  if (patch.deliveryUpdates !== undefined) row.delivery_updates = patch.deliveryUpdates;
  if (patch.roleUpdates !== undefined) row.role_updates = patch.roleUpdates;
  if (patch.deliveryAvailableEnabled !== undefined) row.delivery_available_enabled = patch.deliveryAvailableEnabled;
  if (patch.deliveryClaimedEnabled !== undefined) row.delivery_claimed_enabled = patch.deliveryClaimedEnabled;
  if (patch.deliveryCollectedEnabled !== undefined) row.delivery_collected_enabled = patch.deliveryCollectedEnabled;
  return row;
}

// --- Pub-sub -------------------------------------------------------------
// Declared before refreshNotificationCache/the subscribeAuth wiring below,
// since subscribeAuth calls its callback synchronously and immediately on
// subscribe — refreshNotificationCache's early-return branch calls notify()/
// notifyPrefs() right away, which would be a temporal-dead-zone error if
// these were declared any later (same ordering rule orderLifecycle.js's own
// header comment documents for its identical pattern).
const listeners = new Set();
function notify() {
  listeners.forEach(fn => fn(cache.notifications));
}
export function subscribeNotifications(fn) {
  listeners.add(fn);
  fn(cache.notifications);
  return () => listeners.delete(fn);
}

const prefsListeners = new Set();
function notifyPrefs() {
  prefsListeners.forEach(fn => fn());
}
export function subscribeNotificationPreferences(fn) {
  prefsListeners.add(fn);
  fn();
  return () => prefsListeners.delete(fn);
}

// --- Cache -------------------------------------------------------------
// RLS already scopes both tables to auth.uid() (see 0009/0007), so this
// cache only ever holds the CURRENT user's own notifications/prefs row —
// there is no cross-user data sitting in memory to accidentally leak
// between accounts on a shared device.
let cache = { notifications: [], prefs: null };
export let notificationCacheReady = false;

export async function refreshNotificationCache() {
  const userId = getCurrentUserId();
  if (!userId) {
    cache = { notifications: [], prefs: null };
    notificationCacheReady = true;
    notify();
    notifyPrefs();
    return;
  }
  const [notifsRes, prefsRes] = await Promise.all([
    supabase.from('notifications').select('*'),
    supabase.from('notification_preferences').select('*').maybeSingle(),
  ]);
  cache = {
    notifications: (notifsRes.data || []).map(mapNotificationRow),
    prefs: prefsRes.data ? mapPrefsRow(prefsRes.data) : null,
  };
  notificationCacheReady = true;
  notify();
  notifyPrefs();
}

// Refetches on every auth transition (login, logout, account switch) —
// clears to empty immediately on logout, loads fresh on login, exactly like
// community.js/sites.js/orderLifecycle.js's identical subscriptions. This is
// in addition to main.js's explicit refreshDataCaches() on view entry/focus.
subscribeAuth(() => { refreshNotificationCache(); });

// --- Reads (synchronous, cache-backed) ------------------------------------

export function getNotificationsFor(userId) {
  return cache.notifications.filter(n => n.recipientUserId === userId).sort((a, b) => b.createdAt - a.createdAt);
}

export function getUnreadCount(userId) {
  return cache.notifications.filter(n => n.recipientUserId === userId && !n.read).length;
}

// userId is accepted for interface parity with the pre-8D.1 signature (every
// call site already passes getCurrentUserId()) — RLS means the cache can
// only ever contain the current user's own preferences row regardless, so a
// mismatched userId would just fall through to defaults, never someone
// else's real preferences.
export function getPreferences(userId) {
  if (userId !== getCurrentUserId()) return { ...DEFAULT_PREFS };
  return cache.prefs ? { ...DEFAULT_PREFS, ...cache.prefs } : { ...DEFAULT_PREFS };
}

// --- Writes (genuinely async) ---------------------------------------------

export async function markRead(id) {
  const { data, error } = await supabase.from('notifications')
    .update({ read: true, read_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();
  if (error) return { ok: false, error: error.message };
  const mapped = mapNotificationRow(data);
  const idx = cache.notifications.findIndex(n => n.id === id);
  if (idx !== -1) cache.notifications[idx] = mapped;
  notify();
  return { ok: true };
}

export async function markUnread(id) {
  const { data, error } = await supabase.from('notifications')
    .update({ read: false, read_at: null })
    .eq('id', id)
    .select()
    .single();
  if (error) return { ok: false, error: error.message };
  const mapped = mapNotificationRow(data);
  const idx = cache.notifications.findIndex(n => n.id === id);
  if (idx !== -1) cache.notifications[idx] = mapped;
  notify();
  return { ok: true };
}

// RLS's own using-clause (recipient_user_id = auth.uid()) is the real
// boundary here — this UPDATE's WHERE clause is a query-shaping convenience
// on top of that, not the security check itself.
export async function markAllRead(userId) {
  const { data, error } = await supabase.from('notifications')
    .update({ read: true, read_at: new Date().toISOString() })
    .eq('recipient_user_id', userId)
    .eq('read', false)
    .select();
  if (error) return { ok: false, error: error.message };
  (data || []).forEach(row => {
    const mapped = mapNotificationRow(row);
    const idx = cache.notifications.findIndex(n => n.id === mapped.id);
    if (idx !== -1) cache.notifications[idx] = mapped; else cache.notifications.push(mapped);
  });
  notify();
  return { ok: true };
}

export async function savePreferences(userId, patch) {
  const row = { user_id: userId, ...prefsPatchToRow({ ...DEFAULT_PREFS, ...patch }), updated_at: new Date().toISOString() };
  const { data, error } = await supabase.from('notification_preferences')
    .upsert(row, { onConflict: 'user_id' })
    .select()
    .single();
  if (error) return { ok: false, error: error.message };
  cache.prefs = mapPrefsRow(data);
  notifyPrefs();
  return { ok: true };
}
