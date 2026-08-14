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
const TRANSITIONS = {
  pending_approval: { approve: 'pending_purchase', reject: 'rejected' },
  rejected: { revert: 'pending_approval' },
  pending_purchase: { revert: 'pending_approval', start_purchase: 'purchase_in_progress' },
  purchase_in_progress: { abandon_purchase: 'pending_purchase', complete_purchase: 'purchased' },
  purchased: { claim: 'claimed' },
  claimed: { collect: 'collected', cancel: 'purchased' },
  collected: { deliver: 'delivered' },
  delivered: {},
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
      message: `${actorName || 'A worker'} requested ${orderLabel(order)}.`,
      communityId: order.communityId,
      orderId: order.id,
      actorId,
      actorName,
      navigationTarget: { communityId: order.communityId, role: 'owner', orderId: order.id },
    });
  } else {
    notifyUsers(getBuyerIds(order.communityId), {
      type: 'order_ready_for_purchase',
      title: 'Order ready to purchase',
      message: `${orderLabel(order)} — ${formatPrice(order.totalPrice)} — is ready to purchase.`,
      communityId: order.communityId,
      orderId: order.id,
      actorId,
      actorName,
      navigationTarget: { communityId: order.communityId, role: 'buyer', orderId: order.id },
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
      message: `${orderLabel(result.order)} — ${formatPrice(result.order.totalPrice)} — was approved and is ready to purchase.`,
      communityId: result.order.communityId,
      orderId: result.order.id,
      actorId,
      actorName,
      navigationTarget: { communityId: result.order.communityId, role: 'buyer', orderId: result.order.id },
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
      message: `${actorName || 'The owner'} rejected ${orderLabel(result.order)}${reason ? `: ${reason}` : '.'}`,
      communityId: result.order.communityId,
      orderId: result.order.id,
      actorId,
      actorName,
      navigationTarget: { communityId: result.order.communityId, role: 'worker', orderId: result.order.id },
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
      message: `${actorName || 'The owner'} reverted the decision on ${orderLabel(result.order)} — it's back awaiting approval.`,
      communityId: result.order.communityId,
      orderId: result.order.id,
      actorId,
      actorName,
      navigationTarget: { communityId: result.order.communityId, role: 'worker', orderId: result.order.id },
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
    notifyUsers(approvedMembers(result.order.communityId), {
      type: 'delivery_available',
      title: 'New delivery available',
      message: `${orderLabel(result.order)} is ready for pickup from ${result.order.stockistName || 'the stockist'}.`,
      communityId: result.order.communityId,
      orderId: result.order.id,
      actorId,
      actorName,
      navigationTarget: { communityId: result.order.communityId, role: 'driver', orderId: result.order.id },
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
      message: `${actorName || 'A driver'} claimed ${orderLabel(result.order)} for delivery.`,
      communityId: result.order.communityId,
      orderId: result.order.id,
      actorId,
      actorName,
      navigationTarget: { communityId: result.order.communityId, role: 'buyer', orderId: result.order.id },
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
      message: `${orderLabel(result.order)} has been collected and is on its way.`,
      communityId: result.order.communityId,
      orderId: result.order.id,
      actorId,
      actorName,
      navigationTarget: { communityId: result.order.communityId, role: 'buyer', orderId: result.order.id },
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
    const message = `${orderLabel(o)} was delivered to ${o.deliveryLocation}.`;
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
        actorId,
        actorName,
        navigationTarget: { communityId: o.communityId, role: 'buyer', orderId: o.id },
      });
    }
    if (o.requestedById) {
      notifyUsers([o.requestedById], {
        type: 'order_delivered',
        title: 'Order delivered',
        message,
        communityId: o.communityId,
        orderId: o.id,
        actorId,
        actorName,
        navigationTarget: { communityId: o.communityId, role: 'worker', orderId: o.id },
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
        message: `${actorName || 'The driver'} cancelled the delivery for ${orderLabel(o)}: ${trimmedReason}. It's back in the driver pool.`,
        communityId: o.communityId,
        orderId: o.id,
        actorId,
        actorName,
        navigationTarget: { communityId: o.communityId, role: 'buyer', orderId: o.id },
      });
    }
    notifyUsers(getOwnerIds(o.communityId), {
      type: 'delivery_cancelled',
      title: 'Delivery cancelled',
      message: `${actorName || 'A driver'} cancelled the delivery for ${orderLabel(o)}: ${trimmedReason}.`,
      communityId: o.communityId,
      orderId: o.id,
      actorId,
      actorName,
      navigationTarget: { communityId: o.communityId, role: 'owner', orderId: o.id },
    });
  }
  return result;
}
