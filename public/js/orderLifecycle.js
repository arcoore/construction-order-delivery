// The single entry point for every order state change — Phase 8C rewrite.
// Orders, order events, and cancellation requests are now real Supabase
// tables (RLS-enforced, server-authoritative RPC functions in
// supabase/migrations/0010_order_lifecycle_functions.sql /
// 0012_widen_edit_order.sql), replacing store.js and cancellationRequests.js
// entirely — neither file exists anymore; this module absorbs both.
//
// CACHE LIFECYCLE (same contract Phase 8B established for community.js/
// sites.js — read that pattern first if you haven't):
// Every read export below (getOrders, getOrderEvents, getEventsForCommunity,
// subscribe, subscribeOrderEvents, the four cancellation-request reads,
// subscribeCancellationRequests) is SYNCHRONOUS on purpose — owner.js/
// buyer.js/driver.js/site.js/sitesView.js call them inline inside
// synchronous render code that isn't being converted to async. They read an
// in-memory cache (orders/events/cancellationRequests) kept fresh by real
// Supabase traffic. Every write export is genuinely `async` — call sites in
// those five files now `await` them (Phase 8C's whole point was ending the
// hybrid; unlike Phase 8B, these UI files ARE touched this phase, since
// several of them synchronously branch on a write's return value in a way
// that Phase 8B's boolean permission checks never did — see PROGRESS.md's
// Phase 8C entry for the full reasoning).
//
// NEVER write to localStorage for orders/events/cancellation requests, and
// never fall back to a local write on a failed Supabase call — the database
// is the only source of truth for this data now. A failed RPC call always
// resolves { ok: false, error }, never silently succeeds locally.
//
// ACTOR IDENTITY: every RPC function derives the acting user from auth.uid()
// and the acting display name from a server-side profiles lookup
// (_current_display_name()) — never from a parameter. This module doesn't
// accept or send actorId/actorName to any RPC.
//
// NOTIFICATIONS (Phase 8D.1): every order-lifecycle notification is now
// written server-side, inside the same RPC/transaction as the state change
// itself and the order_events insert — see
// supabase/migrations/0014_notifications_backend.sql. This module no longer
// imports or calls notifications.js at all; there is nothing left for it to
// do here once the RPC call above has resolved.
//
// PRICING TRUST BOUNDARY: unit_price is still client-supplied — there is no
// server-side product/stockist catalogue (public/js/data.js is a static
// frontend file with no Postgres table backing it), so the server cannot
// independently verify a unit_price is the real supplier price. What IS
// server-enforced: unit_price must be non-negative (a real check constraint,
// migrations/0012), and total_price is ALWAYS server-computed as
// unit_price * quantity — this module never sends a total_price to any RPC,
// and nothing in this file trusts totalPrice for anything numeric.
import { supabase } from './supabaseClient.js';
import { getCurrentUserId } from './identity.js';
import { subscribeAuth } from './auth.js';
import { refreshCommunityCache } from './community.js';
import { refreshSitesCache } from './sites.js';

export const REVERT_WINDOW_MS = 72 * 60 * 60 * 1000; // documented server-side too (0010's revert_approval) — kept exported since nothing currently reads it, but harmless to preserve for any future UI countdown display.

// --- Cache -----------------------------------------------------------
let cache = { orders: [], events: [], cancellationRequests: [] };
export let orderCacheReady = false;

function mapOrderRow(r) {
  return {
    id: r.id,
    communityId: r.community_id,
    siteId: r.site_id,
    siteName: r.site_name,
    siteAddress: r.site_address,
    sitePostcode: r.site_postcode,
    siteDeliveryInstructions: r.site_delivery_instructions,
    productId: r.product_id,
    productName: r.product_name,
    variant: r.variant,
    quantity: r.quantity,
    unit: r.unit,
    deliveryPostcode: r.delivery_postcode,
    deliveryLat: r.delivery_lat,
    deliveryLon: r.delivery_lon,
    requestedById: r.requested_by_id,
    requestedBy: r.requested_by,
    status: r.status,
    approvalWasRequired: r.approval_was_required,
    createdAt: new Date(r.created_at).getTime(),
    driverId: r.driver_id,
    driver: r.driver,
    claimedAt: r.claimed_at ? new Date(r.claimed_at).getTime() : null,
    collectedAt: r.collected_at ? new Date(r.collected_at).getTime() : null,
    deliveredAt: r.delivered_at ? new Date(r.delivered_at).getTime() : null,
    deliveryTime: r.delivery_time ? new Date(r.delivery_time).getTime() : null,
    deliveryLocation: r.delivery_location,
    stockistId: r.stockist_id,
    stockistName: r.stockist_name,
    stockistWebsite: r.stockist_website,
    stockistPostcode: r.stockist_postcode,
    pickupEstimate: r.pickup_estimate,
    unitPrice: r.unit_price,
    totalPrice: r.total_price,
    approvedById: r.approved_by_id,
    approvedBy: r.approved_by,
    approvedAt: r.approved_at ? new Date(r.approved_at).getTime() : null,
    rejectedById: r.rejected_by_id,
    rejectedBy: r.rejected_by,
    rejectedAt: r.rejected_at ? new Date(r.rejected_at).getTime() : null,
    rejectionReason: r.rejection_reason,
    purchaseStartedById: r.purchase_started_by_id,
    purchaseStartedBy: r.purchase_started_by,
    purchaseStartedAt: r.purchase_started_at ? new Date(r.purchase_started_at).getTime() : null,
    purchasedById: r.purchased_by_id,
    purchasedBy: r.purchased_by,
    purchasedAt: r.purchased_at ? new Date(r.purchased_at).getTime() : null,
    cancelledById: r.cancelled_by_id,
    cancelledBy: r.cancelled_by,
    cancelledAt: r.cancelled_at ? new Date(r.cancelled_at).getTime() : null,
    cancellationReason: r.cancellation_reason,
    orderCancelledById: r.order_cancelled_by_id,
    orderCancelledBy: r.order_cancelled_by,
    orderCancelledAt: r.order_cancelled_at ? new Date(r.order_cancelled_at).getTime() : null,
    orderCancellationReason: r.order_cancellation_reason,
    version: r.version,
  };
}

function mapEventRow(r) {
  return {
    id: r.id,
    orderId: r.order_id,
    communityId: r.community_id,
    type: r.type,
    actorId: r.actor_id,
    actorName: r.actor_name,
    fromStatus: r.from_status,
    toStatus: r.to_status,
    reason: r.reason,
    meta: r.meta,
    createdAt: new Date(r.created_at).getTime(),
  };
}

function mapCancellationRequestRow(r) {
  return {
    id: r.id,
    orderId: r.order_id,
    communityId: r.community_id,
    siteId: r.site_id,
    requestedById: r.requested_by_id,
    requestedBy: r.requested_by,
    reason: r.reason,
    status: r.status,
    createdAt: new Date(r.created_at).getTime(),
    decidedAt: r.decided_at ? new Date(r.decided_at).getTime() : null,
    decidedById: r.decided_by_id,
    decidedBy: r.decided_by,
    decisionReason: r.decision_reason,
  };
}

// --- Pub-sub -----------------------------------------------------------
// Declared before refreshOrderCache/the subscribeAuth wiring below, since
// subscribeAuth calls its callback synchronously and immediately on
// subscribe — refreshOrderCache's early-return branch calls notifyOrders()
// etc. right away, which would be a temporal-dead-zone error if these were
// declared any later in the file.

const orderListeners = new Set();
function notifyOrders() {
  orderListeners.forEach(fn => fn(cache.orders));
}
export function subscribe(fn) {
  orderListeners.add(fn);
  fn(cache.orders);
  return () => orderListeners.delete(fn);
}

const eventListeners = new Set();
function notifyEvents() {
  eventListeners.forEach(fn => fn(cache.events));
}
export function subscribeOrderEvents(fn) {
  eventListeners.add(fn);
  fn(cache.events);
  return () => eventListeners.delete(fn);
}

const cancellationRequestListeners = new Set();
function notifyCancellationRequests() {
  cancellationRequestListeners.forEach(fn => fn());
}
export function subscribeCancellationRequests(fn) {
  cancellationRequestListeners.add(fn);
  fn();
  return () => cancellationRequestListeners.delete(fn);
}

// Full refetch of all three tables this module owns — same pattern as
// community.js's refreshCommunityCache. Called reactively on every auth
// transition, explicitly in main.js's bootstrap, and via main.js's existing
// refreshDataCaches() on view entry / window focus.
export async function refreshOrderCache() {
  const userId = getCurrentUserId();
  if (!userId) {
    cache = { orders: [], events: [], cancellationRequests: [] };
    orderCacheReady = true;
    notifyOrders();
    notifyEvents();
    notifyCancellationRequests();
    return;
  }
  const [ordersRes, eventsRes, crRes] = await Promise.all([
    supabase.from('orders').select('*'),
    supabase.from('order_events').select('*'),
    supabase.from('cancellation_requests').select('*'),
  ]);
  cache = {
    orders: (ordersRes.data || []).map(mapOrderRow),
    events: (eventsRes.data || []).map(mapEventRow),
    cancellationRequests: (crRes.data || []).map(mapCancellationRequestRow),
  };
  orderCacheReady = true;
  notifyOrders();
  notifyEvents();
  notifyCancellationRequests();
}

subscribeAuth(() => { refreshOrderCache(); });

// --- Sync reads ----------------------------------------------------------

export function getOrders() {
  return cache.orders;
}

export function getOrderEvents(orderId) {
  return cache.events.filter(e => e.orderId === orderId).sort((a, b) => a.createdAt - b.createdAt);
}

export function getEventsForCommunity(communityId) {
  return cache.events.filter(e => e.communityId === communityId).sort((a, b) => b.createdAt - a.createdAt);
}

export function getCancellationRequests() {
  return cache.cancellationRequests;
}

export function getCancellationRequest(requestId) {
  return cache.cancellationRequests.find(r => r.id === requestId) || null;
}

export function getCancellationRequestsForOrder(orderId) {
  return cache.cancellationRequests.filter(r => r.orderId === orderId);
}

export function getPendingCancellationRequestForOrder(orderId) {
  return cache.cancellationRequests.find(r => r.orderId === orderId && r.status === 'pending') || null;
}

function getOrder(orderId) {
  return cache.orders.find(o => o.id === orderId) || null;
}

// --- Cache mutation helpers ------------------------------------------

function upsertOrder(order) {
  const idx = cache.orders.findIndex(o => o.id === order.id);
  if (idx === -1) cache.orders.push(order); else cache.orders[idx] = order;
  notifyOrders();
  return order;
}

function upsertEvents(rows) {
  rows.forEach(r => cache.events.push(r));
  notifyEvents();
}

function upsertCancellationRequest(request) {
  const idx = cache.cancellationRequests.findIndex(r => r.id === request.id);
  if (idx === -1) cache.cancellationRequests.push(request); else cache.cancellationRequests[idx] = request;
  notifyCancellationRequests();
  return request;
}

// Re-fetches a single order/request from Supabase and merges it into cache —
// used after a stale/race/permission failure so the UI reflects reality
// instead of continuing to show a cached state the server just proved
// wrong. A missing row (RLS no longer returns it — access was revoked) is
// removed from the cache rather than left stale.
async function refreshOneOrder(orderId) {
  const { data } = await supabase.from('orders').select('*').eq('id', orderId).maybeSingle();
  if (data) {
    upsertOrder(mapOrderRow(data));
  } else {
    cache.orders = cache.orders.filter(o => o.id !== orderId);
    notifyOrders();
  }
}

async function refreshOneCancellationRequest(requestId) {
  const { data } = await supabase.from('cancellation_requests').select('*').eq('id', requestId).maybeSingle();
  if (data) {
    upsertCancellationRequest(mapCancellationRequestRow(data));
  } else {
    cache.cancellationRequests = cache.cancellationRequests.filter(r => r.id !== requestId);
    notifyCancellationRequests();
  }
}

// Every write function funnels its failure through here. errcodes 40001
// (stale/lost-a-race), 42704 (not found), and 42501 (permission refused)
// all mean "the cached state the UI was showing is no longer current" —
// refresh the specific row so the UI can re-render off reality, per the
// approved Phase 8C stale-refresh rule. 42501 additionally refreshes the
// Phase 8B community/site caches, since a permission refusal here can mean
// a grant was revoked mid-session, not just an order race. 23514/22023
// (validation) are pure input problems — no cache is stale, no refresh.
async function handleRpcFailure(error, { orderId, requestId } = {}) {
  const code = error.code;
  if (code === '40001' || code === '42704' || code === '42501') {
    const refreshes = [];
    if (orderId) refreshes.push(refreshOneOrder(orderId));
    if (requestId) refreshes.push(refreshOneCancellationRequest(requestId));
    if (code === '42501') {
      refreshes.push(refreshCommunityCache());
      refreshes.push(refreshSitesCache());
    }
    await Promise.all(refreshes);
  }
  return { ok: false, error: error.message };
}

// --- Order creation -------------------------------------------------------

// fields: { communityId, siteId, productId, productName, variant, quantity,
// unit, deliveryPostcode, deliveryLat, deliveryLon, stockistId,
// stockistName, stockistWebsite, stockistPostcode, pickupEstimate,
// unitPrice }. Approval-required and site authorization are both derived
// server-side (create_order reads the community's own require_owner_approval
// column and re-checks can_create_order_for_site itself) — this function no
// longer pre-checks either, since the RPC is now the sole authority on both.
export async function createOrder(fields) {
  const { data, error } = await supabase.rpc('create_order', {
    p_community_id: fields.communityId,
    p_site_id: fields.siteId,
    p_product_id: fields.productId,
    p_product_name: fields.productName,
    p_variant: fields.variant ?? null,
    p_quantity: fields.quantity,
    p_unit: fields.unit,
    p_delivery_postcode: fields.deliveryPostcode,
    p_delivery_lat: fields.deliveryLat ?? null,
    p_delivery_lon: fields.deliveryLon ?? null,
    p_stockist_id: fields.stockistId ?? null,
    p_stockist_name: fields.stockistName ?? null,
    p_stockist_website: fields.stockistWebsite ?? null,
    p_stockist_postcode: fields.stockistPostcode ?? null,
    p_pickup_estimate: fields.pickupEstimate ?? null,
    p_unit_price: fields.unitPrice ?? null,
  });
  if (error) return handleRpcFailure(error);

  const order = upsertOrder(mapOrderRow(data));
  // The order_created event is written server-side by the RPC itself; pull
  // it into the event cache too so a subscribed timeline updates immediately
  // rather than waiting for the next full refresh.
  const { data: eventRows } = await supabase.from('order_events').select('*').eq('order_id', order.id);
  if (eventRows) upsertEvents(eventRows.map(mapEventRow).filter(e => !cache.events.some(existing => existing.id === e.id)));

  // The order_awaiting_approval / order_ready_for_purchase notification is
  // written server-side by create_order itself (see
  // supabase/migrations/0014_notifications_backend.sql) — nothing to do here.
  return { ok: true, order };
}

// --- Worker corrections & cancellation --------------------------------

// fields: same shape as createOrder's minus communityId, plus siteId if it's
// changing. p_expected_version is read from the current cache automatically
// — callers don't need to track it themselves, matching the original
// signature's simplicity from the caller's point of view.
export async function editOrder(orderId, fields) {
  const current = getOrder(orderId);
  if (!current) return { ok: false, error: 'Order not found.' };

  const { data, error } = await supabase.rpc('edit_order', {
    p_order_id: orderId,
    p_expected_version: current.version,
    p_product_id: fields.productId,
    p_product_name: fields.productName,
    p_variant: fields.variant ?? null,
    p_quantity: fields.quantity,
    p_unit: fields.unit,
    p_delivery_postcode: fields.deliveryPostcode,
    p_delivery_lat: fields.deliveryLat ?? null,
    p_delivery_lon: fields.deliveryLon ?? null,
    p_site_id: fields.siteId ?? current.siteId,
    p_stockist_id: fields.stockistId ?? null,
    p_stockist_name: fields.stockistName ?? null,
    p_stockist_website: fields.stockistWebsite ?? null,
    p_stockist_postcode: fields.stockistPostcode ?? null,
    p_pickup_estimate: fields.pickupEstimate ?? null,
    p_unit_price: fields.unitPrice ?? null,
  });
  if (error) return handleRpcFailure(error, { orderId });

  const order = upsertOrder(mapOrderRow(data));
  const { data: eventRows } = await supabase.from('order_events').select('*').eq('order_id', orderId).order('created_at', { ascending: false }).limit(2);
  if (eventRows) upsertEvents(eventRows.map(mapEventRow).filter(e => !cache.events.some(existing => existing.id === e.id)));

  // The forced-reapproval order_awaiting_approval notification (when this
  // edit reset an already-approved order) is written server-side by
  // edit_order itself — see supabase/migrations/0014_notifications_backend.sql.
  return { ok: true, order };
}

export async function cancelOrderDirect(orderId, reason) {
  const { data, error } = await supabase.rpc('cancel_order_direct', {
    p_order_id: orderId,
    p_reason: reason || null,
  });
  if (error) return handleRpcFailure(error, { orderId });
  const order = upsertOrder(mapOrderRow(data));
  return { ok: true, order };
}

export async function requestCancellation(orderId, reason) {
  const { data, error } = await supabase.rpc('request_cancellation', {
    p_order_id: orderId,
    p_reason: reason,
  });
  if (error) return handleRpcFailure(error, { orderId });

  const request = upsertCancellationRequest(mapCancellationRequestRow(data));

  // The cancellation_requested notification (to the buyer, when the order
  // has one) is written server-side by request_cancellation itself.
  return { ok: true, request };
}

// --- Owner actions ---------------------------------------------------------

export async function approveOrder(orderId) {
  const { data, error } = await supabase.rpc('approve_order', { p_order_id: orderId });
  if (error) return handleRpcFailure(error, { orderId });
  const order = upsertOrder(mapOrderRow(data));

  // The order_ready_for_purchase notification (to buyers) is written
  // server-side by approve_order itself.
  return { ok: true, order };
}

export async function rejectOrder(orderId, reason) {
  const { data, error } = await supabase.rpc('reject_order', { p_order_id: orderId, p_reason: reason || null });
  if (error) return handleRpcFailure(error, { orderId });
  const order = upsertOrder(mapOrderRow(data));

  // The order_rejected notification (to the requester) is written
  // server-side by reject_order itself.
  return { ok: true, order };
}

export async function revertApproval(orderId) {
  const { data, error } = await supabase.rpc('revert_approval', { p_order_id: orderId });
  if (error) return handleRpcFailure(error, { orderId });
  const order = upsertOrder(mapOrderRow(data));

  // The approval_reverted notification (to the requester) is written
  // server-side by revert_approval itself.
  return { ok: true, order };
}

// --- Buyer actions -----------------------------------------------------

export async function startPurchase(orderId) {
  const { data, error } = await supabase.rpc('start_purchase', { p_order_id: orderId });
  if (error) return handleRpcFailure(error, { orderId });
  return { ok: true, order: upsertOrder(mapOrderRow(data)) };
}

export async function abandonPurchase(orderId) {
  const { data, error } = await supabase.rpc('abandon_purchase', { p_order_id: orderId });
  if (error) return handleRpcFailure(error, { orderId });
  return { ok: true, order: upsertOrder(mapOrderRow(data)) };
}

export async function completePurchase(orderId) {
  const { data, error } = await supabase.rpc('complete_purchase', { p_order_id: orderId });
  if (error) return handleRpcFailure(error, { orderId });
  const order = upsertOrder(mapOrderRow(data));

  // The delivery_available notification (to approved members) is written
  // server-side by complete_purchase itself.
  return { ok: true, order };
}

export async function decideCancellationRequest(requestId, decision, decisionReason) {
  const { data, error } = await supabase.rpc('decide_cancellation_request', {
    p_request_id: requestId,
    p_decision: decision,
    p_decision_reason: decisionReason || null,
  });
  if (error) return handleRpcFailure(error, { requestId });

  // Not an exception — decide_cancellation_request returns a jsonb result
  // even on the deterministic "collected before decision" auto-close, per
  // its own documented design (kept exactly as-is, per the approved Phase
  // 8C decision not to change this RPC's response shape). Refetch both
  // the request and the order regardless of outcome so the cache reflects
  // exactly what the server just did.
  const result = data;
  await refreshOneCancellationRequest(requestId);
  const request = getCancellationRequest(requestId);
  const orderIdForRefresh = request ? request.orderId : null;
  if (orderIdForRefresh) await refreshOneOrder(orderIdForRefresh);
  const order = orderIdForRefresh ? getOrder(orderIdForRefresh) : null;

  if (!result.ok) {
    // Deterministic auto-close (order was collected before the decision
    // landed) — surfaced to the Buyer as a real, specific refusal, never
    // faked as success.
    return { ok: false, error: 'This order has already been collected and can no longer be cancelled.' };
  }

  // The cancellation_rejected / cancellation_approved notification (to the
  // requester) is written server-side by decide_cancellation_request itself
  // — never on the auto-close branch above, matching the pre-existing
  // behavior exactly (only a real decision notifies, not the deterministic
  // "collected before decision" close-out).
  return { ok: true, request, order };
}

// --- Driver actions ----------------------------------------------------

export async function claimDelivery(orderId) {
  const { data, error } = await supabase.rpc('claim_delivery', { p_order_id: orderId });
  if (error) return handleRpcFailure(error, { orderId });
  const order = upsertOrder(mapOrderRow(data));

  // The delivery_claimed notification (to the buyer) is written
  // server-side by claim_delivery itself.
  return { ok: true, order };
}

export async function collectDelivery(orderId) {
  const { data, error } = await supabase.rpc('mark_collected', { p_order_id: orderId });
  if (error) return handleRpcFailure(error, { orderId });
  const order = upsertOrder(mapOrderRow(data));

  // The delivery_collected notification (to the buyer) is written
  // server-side by mark_collected itself.
  return { ok: true, order };
}

export async function deliverOrder(orderId, deliveryTime, deliveryLocation) {
  if (!deliveryTime) return { ok: false, error: 'A delivery time is required.' };
  if (!deliveryLocation || !deliveryLocation.trim()) return { ok: false, error: 'A delivery location is required.' };

  const { data, error } = await supabase.rpc('mark_delivered', {
    p_order_id: orderId,
    p_delivery_time: new Date(deliveryTime).toISOString(),
    p_delivery_location: deliveryLocation.trim(),
  });
  if (error) return handleRpcFailure(error, { orderId });
  const order = upsertOrder(mapOrderRow(data));

  // The order_delivered notification (to both the buyer and the requester)
  // is written server-side by mark_delivered itself.
  return { ok: true, order };
}

export async function cancelDelivery(orderId, reason) {
  if (!reason || !reason.trim()) return { ok: false, error: 'A reason is required to cancel a delivery.' };
  const trimmedReason = reason.trim();

  const { data, error } = await supabase.rpc('cancel_delivery', { p_order_id: orderId, p_reason: trimmedReason });
  if (error) return handleRpcFailure(error, { orderId });
  const order = upsertOrder(mapOrderRow(data));
  const { data: eventRows } = await supabase.from('order_events').select('*').eq('order_id', orderId).order('created_at', { ascending: false }).limit(2);
  if (eventRows) upsertEvents(eventRows.map(mapEventRow).filter(e => !cache.events.some(existing => existing.id === e.id)));

  // The delivery_cancelled notification (to both the buyer and the owners)
  // is written server-side by cancel_delivery itself.
  return { ok: true, order };
}
