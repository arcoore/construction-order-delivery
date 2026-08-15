// The single guarded entry point for every order state change. UI code
// (site.js/owner.js/driver.js/buyer.js) must never call store.js's
// updateOrder directly for a lifecycle action — every transition here is
// validated against the state machine below and, where relevant, against
// who's actually allowed to make it, so an invalid transition is refused
// at the data layer regardless of what the UI happened to render.
//
// Every transition also appends an immutable event to an append-only log
// (sitestock_order_events_v1). Only addOrderEvent/getOrderEvents/
// getEventsForCommunity/subscribeOrderEvents are exported — there is no
// update/delete, by design, so history can't be edited during normal
// operation.
import { getOrders, addOrder, updateOrder, newId } from './store.js';
import { isOwner, isApprovedMember, getOwnerIds, getBuyerIds, approvedMembers } from './community.js';
import { getSite, canCreateOrderForSite, canPurchaseForSite } from './sites.js';
import { notifyUsers } from './notifications.js';
import { formatPrice } from './data.js';
import {
  getCancellationRequest, createCancellationRequest, updateCancellationRequestDecision,
} from './cancellationRequests.js';

const EVENTS_KEY = 'sitestock_order_events_v1';
export const REVERT_WINDOW_MS = 72 * 60 * 60 * 1000;

const eventListeners = new Set();
function notifyEvents() {
  const events = readEvents();
  eventListeners.forEach(fn => fn(events));
}

function readEvents() {
  try {
    const raw = localStorage.getItem(EVENTS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function writeEvent(event) {
  const events = readEvents();
  events.push(event);
  localStorage.setItem(EVENTS_KEY, JSON.stringify(events));
  notifyEvents();
}

window.addEventListener('storage', e => {
  if (e.key === EVENTS_KEY) notifyEvents();
});

export function subscribeOrderEvents(fn) {
  eventListeners.add(fn);
  fn(readEvents());
  return () => eventListeners.delete(fn);
}

export function getOrderEvents(orderId) {
  return readEvents().filter(e => e.orderId === orderId).sort((a, b) => a.createdAt - b.createdAt);
}

export function getEventsForCommunity(communityId) {
  return readEvents().filter(e => e.communityId === communityId).sort((a, b) => b.createdAt - a.createdAt);
}

function addOrderEvent({ orderId, communityId, type, actorId, actorName, fromStatus, toStatus, reason = null, meta = null }) {
  writeEvent({
    id: newId(),
    orderId,
    communityId,
    type,
    actorId: actorId ?? null,
    actorName: actorName ?? null,
    fromStatus,
    toStatus,
    reason,
    meta,
    createdAt: Date.now(),
  });
}

// The state machine. Keys are the order's current status; values map an
// action name to the status it leads to. Any (status, action) pair not
// listed here is refused.
//
// Phase 7B additions: `edit`/`edit_and_reapprove` (Worker corrections) and
// `cancel_order` (both Worker direct-cancel and Buyer-approved post-purchase
// cancellation, which share one terminal `cancelled` status rather than
// splitting into two — see editOrder/cancelOrderDirect/
// decideCancellationRequest below for why each action name maps where it
// does). `cancel_order` deliberately has no entry at `collected` or
// `delivered` — that's what makes a Buyer's approval of an already-collected
// order's cancellation request fail *at this table*, not just in a
// hand-written status check, exactly the same "no edge = refused"
// discipline every other transition here already relies on. `cancel_order`
// at `purchased`/`claimed` is only ever reachable via
// decideCancellationRequest (an approved Buyer decision) — cancelOrderDirect
// refuses before ever calling applyTransition at those statuses, the same
// way the existing `claimed.cancel` edge (a Driver dropping their own
// claim — an unrelated, unmodified action) is only ever reachable via
// cancelDelivery's own actor check, never exposed generally just because
// the table allows it.
const TRANSITIONS = {
  pending_approval: { approve: 'pending_purchase', reject: 'rejected', edit: 'pending_approval', cancel_order: 'cancelled' },
  rejected: { revert: 'pending_approval' },
  pending_purchase: {
    revert: 'pending_approval', start_purchase: 'purchase_in_progress',
    edit: 'pending_purchase', edit_and_reapprove: 'pending_approval', cancel_order: 'cancelled',
  },
  purchase_in_progress: { abandon_purchase: 'pending_purchase', complete_purchase: 'purchased' },
  purchased: { claim: 'claimed', cancel_order: 'cancelled' },
  claimed: { collect: 'collected', cancel: 'purchased', cancel_order: 'cancelled' },
  collected: { deliver: 'delivered' },
  delivered: {},
  cancelled: {},
};

function getOrder(orderId) {
  return getOrders().find(o => o.id === orderId) || null;
}

function orderLabel(order) {
  return `${order.productName}${order.variant ? ` (${order.variant})` : ''}`;
}

// Re-reads fresh order state, validates the transition is legal from its
// *current* status, applies the patch, and logs one or more events for it —
// all synchronously in one call, which is what makes this safe against two
// near-simultaneous claims/purchases in the same browser: whichever call
// runs first wins, and the second sees the already-updated status and is
// refused.
function applyTransition(orderId, action, patch, buildEvents) {
  const order = getOrder(orderId);
  if (!order) return { ok: false, error: 'Order not found.' };

  const allowed = TRANSITIONS[order.status] || {};
  const toStatus = allowed[action];
  if (!toStatus) {
    return { ok: false, error: `Cannot ${action.replace(/_/g, ' ')} an order in status "${order.status}".` };
  }

  const fromStatus = order.status;
  updateOrder(orderId, { ...patch, status: toStatus });

  const events = buildEvents(fromStatus, toStatus);
  events.forEach(e => addOrderEvent({ orderId, communityId: order.communityId, fromStatus, toStatus, ...e }));

  return { ok: true, order: getOrder(orderId) };
}

// --- Order creation -------------------------------------------------------

// A siteId in `fields` is never itself a permission — this re-derives
// authorization fresh from canCreateOrderForSite (owner, or an approved
// community member who's also a member of this specific site) before
// writing anything, so a worker can't create an order for a site they
// aren't assigned to no matter what the UI happened to let them submit.
// The site's name/address/postcode/deliveryInstructions are snapshotted
// onto the order at this moment — later renames/archives of the site never
// reinterpret an already-placed order.
export function createOrder(fields, actorId, actorName, approvalRequired) {
  const { siteId, communityId } = fields;
  const site = getSite(siteId);
  if (!site) return { ok: false, error: 'Site not found.' };
  if (site.communityId !== communityId) {
    return { ok: false, error: 'This site does not belong to the selected community.' };
  }
  if (!canCreateOrderForSite(siteId, communityId, actorId)) {
    return { ok: false, error: 'You are not authorized to create orders for this site.' };
  }
  if (site.status !== 'active') {
    return { ok: false, error: 'This site is archived and cannot receive new orders.' };
  }

  const status = approvalRequired ? 'pending_approval' : 'pending_purchase';
  const order = {
    id: newId(),
    ...fields,
    siteName: site.name,
    siteAddress: site.address,
    sitePostcode: site.postcode,
    siteDeliveryInstructions: site.deliveryInstructions,
    status,
    approvalWasRequired: approvalRequired,
    createdAt: Date.now(),
    driver: null,
    driverId: null,
    claimedAt: null,
    collectedAt: null,
    deliveredAt: null,
    deliveryTime: null,
    deliveryLocation: null,
    approvedBy: null,
    approvedById: null,
    approvedAt: null,
    rejectedBy: null,
    rejectedById: null,
    rejectedAt: null,
    rejectionReason: null,
    purchaseStartedBy: null,
    purchaseStartedById: null,
    purchaseStartedAt: null,
    purchasedBy: null,
    purchasedById: null,
    purchasedAt: null,
    cancelledBy: null,
    cancelledById: null,
    cancelledAt: null,
    cancellationReason: null,
    // Distinct from cancelledBy/cancelledById/cancelledAt/cancellationReason
    // above, which are specifically about a Driver dropping their own
    // delivery claim (order stays alive, back in the pool). These are about
    // the ORDER itself becoming genuinely, terminally cancelled — via a
    // Worker's direct cancel or a Buyer-approved cancellation request.
    // Reusing the driver's field names for a different meaning would
    // quietly conflate two unrelated events.
    orderCancelledBy: null,
    orderCancelledById: null,
    orderCancelledAt: null,
    orderCancellationReason: null,
  };
  addOrder(order);
  addOrderEvent({
    orderId: order.id,
    communityId: order.communityId,
    type: 'order_created',
    actorId,
    actorName,
    fromStatus: null,
    toStatus: status,
    meta: { approvalRequired },
  });

  if (approvalRequired) {
    notifyUsers(getOwnerIds(order.communityId), {
      type: 'order_awaiting_approval',
      title: 'New order needs approval',
      message: `${actorName || 'A worker'} requested ${orderLabel(order)} for ${order.siteName || 'the site'}.`,
      communityId: order.communityId,
      orderId: order.id,
      siteId: order.siteId,
      actorId,
      actorName,
      navigationTarget: { communityId: order.communityId, role: 'owner', orderId: order.id, siteId: order.siteId },
    });
  } else {
    notifyUsers(getBuyerIds(order.communityId), {
      type: 'order_ready_for_purchase',
      title: 'Order ready to purchase',
      message: `${orderLabel(order)} for ${order.siteName || 'the site'} — ${formatPrice(order.totalPrice)} — is ready to purchase.`,
      communityId: order.communityId,
      orderId: order.id,
      siteId: order.siteId,
      actorId,
      actorName,
      navigationTarget: { communityId: order.communityId, role: 'buyer', orderId: order.id, siteId: order.siteId },
    });
  }

  return { ok: true, order };
}

// --- Owner actions ---------------------------------------------------------

export function approveOrder(orderId, actorId, actorName) {
  const order = getOrder(orderId);
  if (!order) return { ok: false, error: 'Order not found.' };
  if (!isOwner(order.communityId, actorId)) return { ok: false, error: 'Only the owner can approve orders.' };

  const result = applyTransition(orderId, 'approve', {
    approvedBy: actorName,
    approvedById: actorId,
    approvedAt: Date.now(),
  }, () => [{ type: 'approved', actorId, actorName }]);

  if (result.ok) {
    notifyUsers(getBuyerIds(result.order.communityId), {
      type: 'order_ready_for_purchase',
      title: 'Order ready to purchase',
      message: `${orderLabel(result.order)} for ${result.order.siteName || 'the site'} — ${formatPrice(result.order.totalPrice)} — was approved and is ready to purchase.`,
      communityId: result.order.communityId,
      orderId: result.order.id,
      siteId: result.order.siteId,
      actorId,
      actorName,
      navigationTarget: { communityId: result.order.communityId, role: 'buyer', orderId: result.order.id, siteId: result.order.siteId },
    });
  }
  return result;
}

export function rejectOrder(orderId, actorId, actorName, reason) {
  const order = getOrder(orderId);
  if (!order) return { ok: false, error: 'Order not found.' };
  if (!isOwner(order.communityId, actorId)) return { ok: false, error: 'Only the owner can reject orders.' };

  const result = applyTransition(orderId, 'reject', {
    rejectedBy: actorName,
    rejectedById: actorId,
    rejectedAt: Date.now(),
    rejectionReason: reason || null,
  }, () => [{ type: 'rejected', actorId, actorName, reason: reason || null }]);

  if (result.ok && result.order.requestedById) {
    notifyUsers([result.order.requestedById], {
      type: 'order_rejected',
      title: 'Your order was rejected',
      message: `${actorName || 'The owner'} rejected ${orderLabel(result.order)} for ${result.order.siteName || 'the site'}${reason ? `: ${reason}` : '.'}`,
      communityId: result.order.communityId,
      orderId: result.order.id,
      siteId: result.order.siteId,
      actorId,
      actorName,
      navigationTarget: { communityId: result.order.communityId, role: 'worker', orderId: result.order.id, siteId: result.order.siteId },
    });
  }
  return result;
}

export function revertApproval(orderId, actorId, actorName) {
  const order = getOrder(orderId);
  if (!order) return { ok: false, error: 'Order not found.' };
  if (!isOwner(order.communityId, actorId)) return { ok: false, error: 'Only the owner can revert this decision.' };
  if (!order.approvalWasRequired) {
    return { ok: false, error: 'This order never went through approval, so there is nothing to revert.' };
  }
  const decidedAt = order.approvedAt || order.rejectedAt;
  if (!decidedAt || Date.now() - decidedAt > REVERT_WINDOW_MS) {
    return { ok: false, error: 'The 72-hour revert window has closed.' };
  }

  const result = applyTransition(orderId, 'revert', {
    approvedBy: null,
    approvedById: null,
    approvedAt: null,
    rejectedBy: null,
    rejectedById: null,
    rejectedAt: null,
    rejectionReason: null,
  }, () => [{ type: 'approval_reverted', actorId, actorName }]);

  if (result.ok && result.order.requestedById) {
    notifyUsers([result.order.requestedById], {
      type: 'approval_reverted',
      title: 'Approval decision reverted',
      message: `${actorName || 'The owner'} reverted the decision on ${orderLabel(result.order)} for ${result.order.siteName || 'the site'} — it's back awaiting approval.`,
      communityId: result.order.communityId,
      orderId: result.order.id,
      siteId: result.order.siteId,
      actorId,
      actorName,
      navigationTarget: { communityId: result.order.communityId, role: 'worker', orderId: result.order.id, siteId: result.order.siteId },
    });
  }
  return result;
}

// --- Buyer actions -----------------------------------------------------

export function startPurchase(orderId, actorId, actorName) {
  const order = getOrder(orderId);
  if (!order) return { ok: false, error: 'Order not found.' };
  // canPurchaseForSite already covers "is a buyer at all" (owner, or an
  // approved buyer who's also a member of this order's site) — a single
  // check here, same as createOrder's single canCreateOrderForSite check.
  if (!canPurchaseForSite(order.siteId, order.communityId, actorId)) {
    return { ok: false, error: 'Only an approved buyer with access to this site can purchase this order.' };
  }

  return applyTransition(orderId, 'start_purchase', {
    purchaseStartedBy: actorName,
    purchaseStartedById: actorId,
    purchaseStartedAt: Date.now(),
  }, () => [{ type: 'purchase_started', actorId, actorName }]);
}

export function abandonPurchase(orderId, actorId, actorName) {
  const order = getOrder(orderId);
  if (!order) return { ok: false, error: 'Order not found.' };
  if (order.purchaseStartedById !== actorId) {
    return { ok: false, error: 'Only the buyer who started this purchase can release it.' };
  }

  return applyTransition(orderId, 'abandon_purchase', {
    purchaseStartedBy: null,
    purchaseStartedById: null,
    purchaseStartedAt: null,
  }, () => [{ type: 'purchase_abandoned', actorId, actorName }]);
}

// Confirms the buyer has already completed the purchase externally — this
// does not perform any purchasing itself, it only records the confirmation
// once the 3-second hold (enforced in buyer.js) completes.
export function completePurchase(orderId, actorId, actorName) {
  const order = getOrder(orderId);
  if (!order) return { ok: false, error: 'Order not found.' };
  if (order.purchaseStartedById !== actorId) {
    return { ok: false, error: 'Only the buyer who started this purchase can confirm it.' };
  }

  const result = applyTransition(orderId, 'complete_purchase', {
    purchaseStartedBy: null,
    purchaseStartedById: null,
    purchaseStartedAt: null,
    purchasedBy: actorName,
    purchasedById: actorId,
    purchasedAt: Date.now(),
  }, () => [{ type: 'purchased', actorId, actorName }]);

  if (result.ok) {
    // Driver-pool broadcast — deliberately no price anywhere in this
    // content, generated here rather than left to the UI to hide later.
    // Carries siteId like every other order notification, but drivers are
    // never site-scoped (see main.js's navigateToNotification) — any
    // approved member can claim any purchased order regardless of site
    // membership, unchanged from Phase 4A.
    notifyUsers(approvedMembers(result.order.communityId), {
      type: 'delivery_available',
      title: 'New delivery available',
      message: `${orderLabel(result.order)} for ${result.order.siteName || 'the site'} is ready for pickup from ${result.order.stockistName || 'the stockist'}.`,
      communityId: result.order.communityId,
      orderId: result.order.id,
      siteId: result.order.siteId,
      actorId,
      actorName,
      navigationTarget: { communityId: result.order.communityId, role: 'driver', orderId: result.order.id, siteId: result.order.siteId },
    });
  }
  return result;
}

// --- Driver actions ----------------------------------------------------

export function claimDelivery(orderId, actorId, actorName) {
  const order = getOrder(orderId);
  if (!order) return { ok: false, error: 'Order not found.' };
  if (!isApprovedMember(order.communityId, actorId)) {
    return { ok: false, error: 'Only an approved member of this community can claim deliveries.' };
  }

  const result = applyTransition(orderId, 'claim', {
    driver: actorName,
    driverId: actorId,
    claimedAt: Date.now(),
  }, () => [{ type: 'delivery_claimed', actorId, actorName }]);

  if (result.ok && result.order.purchasedById) {
    notifyUsers([result.order.purchasedById], {
      type: 'delivery_claimed',
      title: 'Driver assigned to your order',
      message: `${actorName || 'A driver'} claimed ${orderLabel(result.order)} for ${result.order.siteName || 'the site'} for delivery.`,
      communityId: result.order.communityId,
      orderId: result.order.id,
      siteId: result.order.siteId,
      actorId,
      actorName,
      navigationTarget: { communityId: result.order.communityId, role: 'buyer', orderId: result.order.id, siteId: result.order.siteId },
    });
  }
  return result;
}

export function collectDelivery(orderId, actorId, actorName) {
  const order = getOrder(orderId);
  if (!order) return { ok: false, error: 'Order not found.' };
  if (order.driverId !== actorId) return { ok: false, error: 'Only the assigned driver can mark this collected.' };

  const result = applyTransition(orderId, 'collect', {
    collectedAt: Date.now(),
  }, () => [{ type: 'collected', actorId, actorName }]);

  if (result.ok && result.order.purchasedById) {
    notifyUsers([result.order.purchasedById], {
      type: 'delivery_collected',
      title: 'Order collected',
      message: `${orderLabel(result.order)} for ${result.order.siteName || 'the site'} has been collected and is on its way.`,
      communityId: result.order.communityId,
      orderId: result.order.id,
      siteId: result.order.siteId,
      actorId,
      actorName,
      navigationTarget: { communityId: result.order.communityId, role: 'buyer', orderId: result.order.id, siteId: result.order.siteId },
    });
  }
  return result;
}

// deliveredAt is recorded automatically (the moment this was confirmed);
// deliveryTime is what the driver reports as when they actually delivered —
// the two can differ (e.g. confirmed later due to no signal), so both are
// kept rather than treating the auto timestamp as the reported one.
export function deliverOrder(orderId, actorId, actorName, deliveryTime, deliveryLocation) {
  const order = getOrder(orderId);
  if (!order) return { ok: false, error: 'Order not found.' };
  if (order.driverId !== actorId) return { ok: false, error: 'Only the assigned driver can mark this delivered.' };
  if (!deliveryTime) return { ok: false, error: 'A delivery time is required.' };
  if (!deliveryLocation || !deliveryLocation.trim()) return { ok: false, error: 'A delivery location is required.' };

  const location = deliveryLocation.trim();
  const result = applyTransition(orderId, 'deliver', {
    deliveredAt: Date.now(),
    deliveryTime,
    deliveryLocation: location,
  }, () => [{
    type: 'delivered',
    actorId,
    actorName,
    meta: { deliveryTime, deliveryLocation: location },
  }]);

  if (result.ok) {
    const o = result.order;
    const message = `${orderLabel(o)} for ${o.siteName || 'the site'} was delivered to ${o.deliveryLocation}.`;
    // Split into two calls rather than one shared recipient list — buyer and
    // worker land in different role-views, so each needs its own
    // navigationTarget rather than one target trying to serve both.
    if (o.purchasedById) {
      notifyUsers([o.purchasedById], {
        type: 'order_delivered',
        title: 'Order delivered',
        message,
        communityId: o.communityId,
        orderId: o.id,
        siteId: o.siteId,
        actorId,
        actorName,
        navigationTarget: { communityId: o.communityId, role: 'buyer', orderId: o.id, siteId: o.siteId },
      });
    }
    if (o.requestedById) {
      notifyUsers([o.requestedById], {
        type: 'order_delivered',
        title: 'Order delivered',
        message,
        communityId: o.communityId,
        orderId: o.id,
        siteId: o.siteId,
        actorId,
        actorName,
        navigationTarget: { communityId: o.communityId, role: 'worker', orderId: o.id, siteId: o.siteId },
      });
    }
  }
  return result;
}

// Cancelling returns the order to the driver pool (status back to
// 'purchased') so another driver can claim it. The order's own driver/
// driverId fields get cleared, so who *was* assigned is only recoverable
// from the event's meta — which is exactly what a future notification
// feature needs to tell the buyer who dropped the delivery and why.
export function cancelDelivery(orderId, actorId, actorName, reason) {
  const order = getOrder(orderId);
  if (!order) return { ok: false, error: 'Order not found.' };
  if (order.driverId !== actorId) return { ok: false, error: 'Only the assigned driver can cancel this delivery.' };
  if (!reason || !reason.trim()) return { ok: false, error: 'A reason is required to cancel a delivery.' };

  const trimmedReason = reason.trim();
  const result = applyTransition(orderId, 'cancel', {
    driver: null,
    driverId: null,
    claimedAt: null,
    cancelledBy: actorName,
    cancelledById: actorId,
    cancelledAt: Date.now(),
    cancellationReason: trimmedReason,
  }, (fromStatus, toStatus) => [
    {
      type: 'delivery_cancelled',
      actorId,
      actorName,
      reason: trimmedReason,
      meta: { previousDriverId: actorId, previousDriverName: actorName, purchasedById: order.purchasedById },
    },
    { type: 'delivery_returned_to_pool', actorId: null, actorName: null },
  ]);

  if (result.ok) {
    const o = result.order;
    if (o.purchasedById) {
      notifyUsers([o.purchasedById], {
        type: 'delivery_cancelled',
        title: 'Delivery cancelled',
        message: `${actorName || 'The driver'} cancelled the delivery for ${orderLabel(o)} for ${o.siteName || 'the site'}: ${trimmedReason}. It's back in the driver pool.`,
        communityId: o.communityId,
        orderId: o.id,
        siteId: o.siteId,
        actorId,
        actorName,
        navigationTarget: { communityId: o.communityId, role: 'buyer', orderId: o.id, siteId: o.siteId },
      });
    }
    notifyUsers(getOwnerIds(o.communityId), {
      type: 'delivery_cancelled',
      title: 'Delivery cancelled',
      message: `${actorName || 'A driver'} cancelled the delivery for ${orderLabel(o)} for ${o.siteName || 'the site'}: ${trimmedReason}.`,
      communityId: o.communityId,
      orderId: o.id,
      siteId: o.siteId,
      actorId,
      actorName,
      navigationTarget: { communityId: o.communityId, role: 'owner', orderId: o.id, siteId: o.siteId },
    });
  }
  return result;
}

// --- Worker corrections & cancellation (Phase 7B) --------------------------
//
// Only ever legal on an order this actor themselves requested — rule #1 is
// absolute here, with no Owner override in this phase (see the Phase 7A
// architecture plan, section U.1). Every function below re-derives
// authorization from a fresh read, exactly like every action above it.

// Fields a Worker edit is ever allowed to touch. Deliberately excludes
// requestedBy/requestedById (provenance, immutable), createdAt, and the
// status/actor-decision fields every other action already owns. siteId is
// handled separately below since changing it requires re-authorizing
// against the *new* site and re-snapshotting its fields — never trusting
// caller-supplied site text, the same discipline createOrder already uses.
const EDITABLE_ORDER_FIELDS = [
  'productId', 'productName', 'variant', 'quantity', 'unit',
  'deliveryPostcode', 'deliveryLat', 'deliveryLon',
  'stockistId', 'stockistName', 'stockistWebsite', 'stockistPostcode', 'pickupEstimate',
  'unitPrice', 'totalPrice',
];

// Applies a Worker's correction to their own order. Which action name gets
// passed to applyTransition depends on more than just the current status —
// it depends on whether a real Owner approval has actually happened
// (order.approvedById), which the TRANSITIONS table alone can't express for
// a single status admitting two different outcomes — so that decision is
// made here, once, before ever touching the shared transition engine.
export function editOrder(orderId, fields, actorId, actorName) {
  const order = getOrder(orderId);
  if (!order) return { ok: false, error: 'Order not found.' };
  if (order.requestedById !== actorId) {
    return { ok: false, error: 'Only the worker who requested this order can edit it.' };
  }
  if (!isApprovedMember(order.communityId, actorId)) {
    return { ok: false, error: 'You are no longer an approved member of this community.' };
  }

  let action;
  if (order.status === 'pending_approval') {
    action = 'edit';
  } else if (order.status === 'pending_purchase') {
    action = order.approvedById ? 'edit_and_reapprove' : 'edit';
  } else if (order.status === 'purchase_in_progress') {
    return { ok: false, error: 'A buyer is currently confirming purchase on this order — try again in a moment.' };
  } else {
    return { ok: false, error: 'This order can no longer be edited directly.' };
  }

  const patch = {};
  const changes = {};

  for (const key of EDITABLE_ORDER_FIELDS) {
    if (fields[key] !== undefined && fields[key] !== order[key]) {
      changes[key] = { from: order[key], to: fields[key] };
      patch[key] = fields[key];
    }
  }

  if (fields.siteId !== undefined && fields.siteId !== order.siteId) {
    const site = getSite(fields.siteId);
    if (!site) return { ok: false, error: 'Site not found.' };
    if (site.communityId !== order.communityId) {
      return { ok: false, error: 'This site does not belong to the selected community.' };
    }
    if (!canCreateOrderForSite(fields.siteId, order.communityId, actorId)) {
      return { ok: false, error: 'You are not authorized to create orders for this site.' };
    }
    if (site.status !== 'active') {
      return { ok: false, error: 'This site is archived and cannot receive new orders.' };
    }
    changes.siteId = { from: order.siteId, to: site.id };
    changes.siteName = { from: order.siteName, to: site.name };
    changes.siteAddress = { from: order.siteAddress, to: site.address };
    changes.sitePostcode = { from: order.sitePostcode, to: site.postcode };
    changes.siteDeliveryInstructions = { from: order.siteDeliveryInstructions, to: site.deliveryInstructions };
    patch.siteId = site.id;
    patch.siteName = site.name;
    patch.siteAddress = site.address;
    patch.sitePostcode = site.postcode;
    patch.siteDeliveryInstructions = site.deliveryInstructions;
  }

  if (Object.keys(changes).length === 0) {
    return { ok: false, error: 'No changes were made.' };
  }

  // Two events from one transition — the same multi-event shape
  // cancelDelivery already uses (delivery_cancelled +
  // delivery_returned_to_pool) — so the diff and the approval-invalidation
  // read as two distinct, honest things in the timeline rather than being
  // folded into one another. The original 'approved' event from when the
  // Owner first signed off is never touched — events are append-only, this
  // just adds to the record, it never overwrites it.
  const events = [{ type: 'order_edited', actorId, actorName, meta: { changes } }];
  if (action === 'edit_and_reapprove') {
    patch.approvedBy = null;
    patch.approvedById = null;
    patch.approvedAt = null;
    events.push({ type: 'approval_reverted', actorId, actorName });
  }

  const result = applyTransition(orderId, action, patch, () => events);

  if (result.ok && action === 'edit_and_reapprove') {
    // Reusing the exact notification the Owner already gets on original
    // creation — from their point of view, "something new needs my
    // attention in Awaiting Approval" is equally true either way. Unlike
    // the Owner's own manual revert (which doesn't re-notify them, since
    // they obviously already know), this is a Worker creating new work for
    // the Owner, which does deserve a ping.
    notifyUsers(getOwnerIds(result.order.communityId), {
      type: 'order_awaiting_approval',
      title: 'New order needs approval',
      message: `${actorName || 'A worker'} edited ${orderLabel(result.order)} for ${result.order.siteName || 'the site'} — it needs approval again.`,
      communityId: result.order.communityId,
      orderId: result.order.id,
      siteId: result.order.siteId,
      actorId,
      actorName,
      navigationTarget: { communityId: result.order.communityId, role: 'owner', orderId: result.order.id, siteId: result.order.siteId },
    });
  }

  return result;
}

// Direct, instant cancellation — only ever legal before any money has been
// spent (rule #5), regardless of whether the order was ever approved.
// purchase_in_progress fails safe: the hold resolves in seconds either way,
// so the Worker just retries once it does. purchased/claimed/collected/
// delivered/cancelled/rejected all fall outside the two statuses this
// function explicitly allows, refused with a clear, specific message rather
// than a generic "invalid transition."
export function cancelOrderDirect(orderId, actorId, actorName, reason) {
  const order = getOrder(orderId);
  if (!order) return { ok: false, error: 'Order not found.' };
  if (order.requestedById !== actorId) {
    return { ok: false, error: 'Only the worker who requested this order can cancel it.' };
  }
  if (!isApprovedMember(order.communityId, actorId)) {
    return { ok: false, error: 'You are no longer an approved member of this community.' };
  }
  if (order.status === 'purchase_in_progress') {
    return { ok: false, error: 'A buyer is currently confirming purchase on this order — try again in a moment.' };
  }
  if (order.status !== 'pending_approval' && order.status !== 'pending_purchase') {
    return { ok: false, error: 'This order can no longer be cancelled directly — once purchased, you can request a cancellation instead.' };
  }

  const trimmedReason = reason && reason.trim() ? reason.trim() : null;

  return applyTransition(orderId, 'cancel_order', {
    orderCancelledBy: actorName,
    orderCancelledById: actorId,
    orderCancelledAt: Date.now(),
    orderCancellationReason: trimmedReason,
  }, () => [
    { type: 'order_cancelled', actorId, actorName, reason: trimmedReason, meta: { via: 'direct' } },
  ]);
}

// --- Post-purchase cancellation requests ------------------------------

// Submits a request rather than cancelling directly — once money's spent,
// the Buyer decides (rule #8). Only legal at purchased/claimed; blocked
// from collected onward, since the goods are then physically with the
// driver and approving a cancellation would need a way to tell them to
// stop/return it, which this phase deliberately doesn't build (see the
// Phase 7A plan, section D). order.status is left completely untouched by
// this call — a pending request must never block a Driver from claiming or
// collecting normally.
export function requestCancellation(orderId, actorId, actorName, reason) {
  const order = getOrder(orderId);
  if (!order) return { ok: false, error: 'Order not found.' };
  if (order.requestedById !== actorId) {
    return { ok: false, error: 'Only the worker who requested this order can request its cancellation.' };
  }
  if (!isApprovedMember(order.communityId, actorId)) {
    return { ok: false, error: 'You are no longer an approved member of this community.' };
  }
  if (order.status !== 'purchased' && order.status !== 'claimed') {
    return { ok: false, error: 'A cancellation request can only be submitted after purchase and before the order is collected.' };
  }
  if (!reason || !reason.trim()) {
    return { ok: false, error: 'A reason is required to request a cancellation.' };
  }

  const trimmedReason = reason.trim();
  const result = createCancellationRequest(orderId, order.communityId, order.siteId, actorId, actorName, trimmedReason);
  if (!result.ok) return result;

  addOrderEvent({
    orderId: order.id,
    communityId: order.communityId,
    type: 'cancellation_requested',
    actorId,
    actorName,
    fromStatus: order.status,
    toStatus: order.status,
    reason: trimmedReason,
    meta: { requestId: result.request.id },
  });

  // Targets the specific buyer who actually purchased it — matching the
  // existing precedent set by delivery_claimed/delivery_collected, which
  // both notify [order.purchasedById] rather than broadcasting to every
  // buyer, since (unlike pre-purchase) there's now a specific person with
  // the most context to act.
  if (order.purchasedById) {
    notifyUsers([order.purchasedById], {
      type: 'cancellation_requested',
      title: 'Cancellation requested',
      message: `${actorName || 'A worker'} requested to cancel ${orderLabel(order)} for ${order.siteName || 'the site'}: ${trimmedReason}`,
      communityId: order.communityId,
      orderId: order.id,
      siteId: order.siteId,
      actorId,
      actorName,
      navigationTarget: { communityId: order.communityId, role: 'buyer', orderId: order.id, siteId: order.siteId },
    });
  }

  return { ok: true, request: result.request, order };
}

// The Buyer's decision. Re-checks everything fresh rather than trusting
// anything about the request or the order as they stood when the UI last
// rendered them — including, for an approval, re-attempting the underlying
// order transition and letting the TRANSITIONS table itself be the final
// word on whether it's still legal (it has no cancel_order edge past
// `claimed`, so an order a Driver has since collected refuses automatically,
// no separate status check needed here to catch that race).
export function decideCancellationRequest(requestId, decision, actorId, actorName, decisionReason) {
  const request = getCancellationRequest(requestId);
  if (!request) return { ok: false, error: 'Cancellation request not found.' };
  if (request.status !== 'pending') {
    return { ok: false, error: 'This cancellation request has already been decided.' };
  }

  const order = getOrder(request.orderId);
  if (!order) return { ok: false, error: 'Order not found.' };
  if (request.communityId !== order.communityId) {
    return { ok: false, error: 'This request does not match the order\'s community.' };
  }
  if (!canPurchaseForSite(order.siteId, order.communityId, actorId)) {
    return { ok: false, error: 'Only an approved buyer with access to this site can decide this request.' };
  }

  const trimmedDecisionReason = decisionReason && decisionReason.trim() ? decisionReason.trim() : null;

  if (decision === 'rejected') {
    updateCancellationRequestDecision(requestId, 'rejected', actorId, actorName, trimmedDecisionReason);
    addOrderEvent({
      orderId: order.id,
      communityId: order.communityId,
      type: 'cancellation_rejected',
      actorId,
      actorName,
      fromStatus: order.status,
      toStatus: order.status,
      reason: trimmedDecisionReason,
      meta: { requestId },
    });
    notifyUsers([request.requestedById], {
      type: 'cancellation_rejected',
      title: 'Cancellation request rejected',
      message: `${actorName || 'The buyer'} rejected your cancellation request for ${orderLabel(order)} for ${order.siteName || 'the site'}${trimmedDecisionReason ? `: ${trimmedDecisionReason}` : '.'}`,
      communityId: order.communityId,
      orderId: order.id,
      siteId: order.siteId,
      actorId,
      actorName,
      navigationTarget: { communityId: order.communityId, role: 'worker', orderId: order.id, siteId: order.siteId },
    });
    return { ok: true, request: getCancellationRequest(requestId), order };
  }

  if (decision === 'approved') {
    const wasClaimed = order.status === 'claimed';
    const previousDriverId = order.driverId;
    const previousDriverName = order.driver;

    const result = applyTransition(order.id, 'cancel_order', {
      orderCancelledBy: actorName,
      orderCancelledById: actorId,
      orderCancelledAt: Date.now(),
      orderCancellationReason: request.reason,
      driver: null,
      driverId: null,
      claimedAt: null,
    }, () => [
      {
        type: 'order_cancelled',
        actorId,
        actorName,
        reason: request.reason,
        meta: { via: 'cancellation_request', requestId, previousDriverId, previousDriverName },
      },
    ]);

    if (!result.ok) {
      // The order progressed past a decidable state (collected) before this
      // decision landed. Close the request out deterministically rather
      // than leaving it dangling as 'pending' forever — the Worker gets a
      // truthful outcome instead of silence.
      const autoReason = 'Automatically closed — the order was collected before a decision was made.';
      updateCancellationRequestDecision(requestId, 'rejected', null, null, autoReason);
      addOrderEvent({
        orderId: order.id,
        communityId: order.communityId,
        type: 'cancellation_rejected',
        actorId: null,
        actorName: null,
        fromStatus: order.status,
        toStatus: order.status,
        reason: autoReason,
        meta: { requestId, autoClosed: true },
      });
      return { ok: false, error: 'This order has already been collected and can no longer be cancelled.' };
    }

    updateCancellationRequestDecision(requestId, 'approved', actorId, actorName, trimmedDecisionReason);

    notifyUsers([request.requestedById], {
      type: 'cancellation_approved',
      title: 'Cancellation approved',
      message: `${actorName || 'The buyer'} approved your cancellation request for ${orderLabel(result.order)} for ${result.order.siteName || 'the site'}.`,
      communityId: result.order.communityId,
      orderId: result.order.id,
      siteId: result.order.siteId,
      actorId,
      actorName,
      navigationTarget: { communityId: result.order.communityId, role: 'worker', orderId: result.order.id, siteId: result.order.siteId },
    });

    // The order stays alive from the Driver's point of view right up until
    // this moment — they otherwise have no way to learn the thing they
    // claimed is no longer needed. Same event, one more recipient, not a
    // new notification type.
    if (wasClaimed && previousDriverId) {
      notifyUsers([previousDriverId], {
        type: 'cancellation_approved',
        title: 'Delivery cancelled',
        message: `${orderLabel(result.order)} for ${result.order.siteName || 'the site'} has been cancelled and no longer needs to be delivered.`,
        communityId: result.order.communityId,
        orderId: result.order.id,
        siteId: result.order.siteId,
        actorId,
        actorName,
        navigationTarget: { communityId: result.order.communityId, role: 'driver', orderId: result.order.id, siteId: result.order.siteId },
      });
    }

    return { ok: true, request: getCancellationRequest(requestId), order: result.order };
  }

  return { ok: false, error: 'Invalid decision.' };
}
