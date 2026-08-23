// Roadmap Step 4 — order operations & status clarity. Pure presentation
// helpers only: no DOM access, no Supabase, no localStorage, no network, no
// mutable module-level application state. Every function here is a plain
// mapping from data already sitting on an order/order_event (order_status
// enum values, order_events rows, needed_by fields) to a short, honest,
// human-readable string or comparator result — nothing here changes what
// data exists, only how it's displayed.
//
// Consolidates what used to be three independently-hand-maintained status
// label dictionaries (site.js's STATUS_LABELS, owner.js's
// DETAIL_STATUS_LABELS, driver.js's STATUS_LABELS) into one source, so a
// future status-wording change has one place to make it instead of three
// (buyer.js's CANCEL_REQUEST_STATUS_LABELS stays separate on purpose — it
// describes a different domain concept, "which stage is this cancellation
// review at," not the order's own status, and only ever covers 3 of the 9
// order_status values).
//
// Database order_status values (supabase/migrations/0001_extensions_and_types.sql)
// are never exposed to a user directly — every function below maps a raw
// value to real, short, role-appropriate English.

import { neededByUrgency } from './deadline.js';

// --- Status labels -----------------------------------------------------

const BASE_STATUS_LABELS = {
  pending_approval: 'Awaiting owner approval',
  rejected: 'Rejected by owner',
  pending_purchase: 'Waiting for a buyer to purchase',
  purchase_in_progress: 'Buyer confirming purchase…',
  purchased: 'Purchased — waiting for a driver',
  claimed: 'Driver assigned',
  collected: 'Collected — in transit',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

// A Driver reading their own list needs framing written from behind the
// wheel ("Ready for pickup," not "Purchased — waiting for a driver" — the
// Driver IS that driver) — every other status is identical for every role,
// so only the two that genuinely need different wording are overridden here
// rather than duplicating the whole map a second time.
const DRIVER_STATUS_LABELS = {
  purchased: 'Ready for pickup',
  claimed: 'Claimed by you',
};

// role: 'worker' | 'owner' | 'driver' | 'buyer' | undefined. Falls back to
// the base (Worker/Owner-shared) wording for any role without its own
// override, and to the raw status string only if it's somehow not one of
// the 9 known order_status values (defensive — should never happen).
export function statusLabel(status, role) {
  if (role === 'driver' && DRIVER_STATUS_LABELS[status]) return DRIVER_STATUS_LABELS[status];
  return BASE_STATUS_LABELS[status] || status;
}

// --- "Who needs to act next" --------------------------------------------

const RESOLVED_STATUSES = new Set(['delivered', 'rejected', 'cancelled']);

// options.pendingCancellationRequest: pass true when a real 'pending'
// cancellation_requests row exists for this order (callers already have
// this via getPendingCancellationRequestForOrder) — the Buyer's decision on
// that request is a more urgent "who's next" fact than the order's own
// status while it's outstanding, for the two statuses (purchased/claimed) a
// cancellation request can actually exist against.
export function nextActionFor(order, role, options = {}) {
  if (RESOLVED_STATUSES.has(order.status)) return null;

  const pendingCancellation = !!options.pendingCancellationRequest;
  if (pendingCancellation && (order.status === 'purchased' || order.status === 'claimed')) {
    return 'Waiting for buyer — cancellation decision';
  }

  switch (order.status) {
    case 'pending_approval':
      return role === 'owner' ? 'Your approval needed' : 'Waiting for owner approval';
    case 'pending_purchase':
      return role === 'buyer' ? 'Ready to purchase' : 'Waiting for a buyer';
    case 'purchase_in_progress':
      return 'Buyer confirming purchase';
    case 'purchased':
      return role === 'driver' ? 'Ready to claim' : 'Waiting for a driver';
    case 'claimed':
      return role === 'driver' ? 'Next: mark as collected' : 'Driver collecting';
    case 'collected':
      return role === 'driver' ? 'Next: deliver' : 'Driver delivering';
    default:
      return null;
  }
}

// --- Deterministic urgency-aware ordering --------------------------------
// Tiers (see CLAUDE.md's Roadmap Step 4 entry for the full rationale):
//   0 overdue   — earliest (most overdue) needed_by first
//   1 asap      — oldest request first (no timestamp exists to rank by)
//   2 today     — earliest needed_by first
//   3 tomorrow  — earliest needed_by first
//   4 future    — earliest needed_by first
//   5 none      — oldest request first (unspecified/historical orders)
// A concrete deadline is never ranked below ASAP forever — a genuinely
// overdue dated order always outranks every ASAP order, satisfying "don't
// let ASAP dominate forever" without needing any predictive logic.
const URGENCY_TIER = { overdue: 0, asap: 1, today: 2, tomorrow: 3, future: 4, none: 5 };

export function urgencyComparator(a, b) {
  const tierA = URGENCY_TIER[neededByUrgency(a.neededByType, a.neededBy, a.status)] ?? URGENCY_TIER.none;
  const tierB = URGENCY_TIER[neededByUrgency(b.neededByType, b.neededBy, b.status)] ?? URGENCY_TIER.none;
  if (tierA !== tierB) return tierA - tierB;
  if (a.neededBy != null && b.neededBy != null && a.neededBy !== b.neededBy) return a.neededBy - b.neededBy;
  return a.createdAt - b.createdAt;
}

// --- Shared event/timeline presentation ----------------------------------
// Moved verbatim from owner.js (Phase 5/7's EVENT_RENDER) — same icon/text
// map, same fallback shape, now the one place both Owner's existing
// dashboard-activity-feed/detail-timeline and the Worker's new inline
// history toggle read from, instead of two independently-maintained copies.
export const EVENT_RENDER = {
  order_created: (e, label) => ({ icon: '📝', text: `${e.actorName || 'Someone'} requested ${label}` }),
  approved: (e, label) => ({ icon: '✅', text: `${e.actorName || 'Owner'} approved ${label}` }),
  rejected: (e, label) => ({ icon: '🚫', text: `${e.actorName || 'Owner'} rejected ${label}${e.reason ? ` — ${e.reason}` : ''}` }),
  approval_reverted: (e, label) => ({ icon: '↩️', text: `${e.actorName || 'Owner'} reverted the decision on ${label}` }),
  purchase_started: (e, label) => ({ icon: '🛒', text: `${e.actorName || 'A buyer'} started purchasing ${label}` }),
  purchase_abandoned: (e, label) => ({ icon: '↩️', text: `${e.actorName || 'A buyer'} released ${label} back to the purchase queue` }),
  purchased: (e, label) => ({ icon: '💳', text: `${e.actorName || 'A buyer'} purchased ${label}` }),
  delivery_claimed: (e, label) => ({ icon: '🚚', text: `${e.actorName || 'A driver'} claimed ${label}` }),
  delivery_cancelled: (e, label) => ({ icon: '⚠️', text: `${e.actorName || 'A driver'} cancelled ${label}${e.reason ? ` — ${e.reason}` : ''}` }),
  delivery_returned_to_pool: (e, label) => ({ icon: '🔁', text: `${label} is back in the driver pool` }),
  collected: (e, label) => ({ icon: '📦', text: `${e.actorName || 'Driver'} collected ${label}` }),
  delivered: (e, label) => ({ icon: '🏁', text: `${label} delivered to ${e.meta?.deliveryLocation || 'site'}` }),
  // Phase 7B/7C — Worker corrections & cancellation.
  order_edited: (e, label) => {
    const changes = e.meta?.changes || {};
    const fieldLabels = {
      quantity: 'quantity', productName: 'material', variant: 'size', siteName: 'site',
      deliveryPostcode: 'delivery postcode', stockistName: 'stockist',
      unitPrice: 'unit price', totalPrice: 'total price',
      neededByType: 'needed by',
    };
    // Only the human-readable half of a paired change is shown (e.g.
    // siteName, not the siteId/address/postcode/instructions that changed
    // alongside it) — full detail still exists in meta.changes itself, this
    // is just the readable summary line. neededBy (the raw timestamp) is
    // skipped the same way in favor of neededByType's plain asap/deadline
    // label — a formatted "Today, 5:00 PM"-style value isn't meaningful
    // without knowing "today" relative to when the diff is being read, so
    // this summary line intentionally stays as simple as siteId/stockistId
    // already are.
    const skip = new Set(['siteId', 'siteAddress', 'sitePostcode', 'siteDeliveryInstructions', 'stockistId', 'stockistWebsite', 'stockistPostcode', 'pickupEstimate', 'productId', 'unit', 'neededBy']);
    const parts = Object.entries(changes)
      .filter(([field]) => !skip.has(field))
      .map(([field, { from, to }]) => `${fieldLabels[field] || field} ${from ?? '—'} → ${to ?? '—'}`);
    return { icon: '✏️', text: `${e.actorName || 'The worker'} edited ${label}${parts.length ? ` — ${parts.join(', ')}` : ''}` };
  },
  order_cancelled: (e, label) => ({
    icon: '❌',
    text: `${e.actorName || 'Someone'} cancelled ${label}${e.reason ? ` — ${e.reason}` : ''}`,
  }),
  cancellation_requested: (e, label) => ({
    icon: '🙋',
    text: `${e.actorName || 'The worker'} requested to cancel ${label}${e.reason ? `: ${e.reason}` : ''}`,
  }),
  cancellation_rejected: (e, label) => {
    if (e.meta?.autoClosed) {
      return { icon: '⏱️', text: `The cancellation request for ${label} could no longer be decided${e.reason ? ` — ${e.reason}` : ''}` };
    }
    return { icon: '🚫', text: `${e.actorName || 'The buyer'} rejected the cancellation request for ${label}${e.reason ? `: ${e.reason}` : ''}` };
  },
};

// A safe generic fallback covers any event type not in the map above (there
// shouldn't be one — all 16 real order_events types are covered — but this
// mirrors the exact fallback owner.js already used, rather than silently
// rendering nothing for a genuinely unknown type).
export function describeEvent(event, label) {
  const render = EVENT_RENDER[event.type];
  return render ? render(event, label) : { icon: '•', text: `${event.type} on ${label}` };
}
