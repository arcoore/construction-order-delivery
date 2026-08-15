// Post-purchase cancellation requests — a Worker's own order can only be
// cancelled directly before purchase (see orderLifecycle.js's
// cancelOrderDirect); once money's been spent, a Worker instead submits a
// request here, and an authorized Buyer decides. Follows the exact module
// shape community.js already established twice (join requests, buyer
// requests): its own storage key, its own pub-sub, its own storage-event
// listener — a request has its own pending/approved/rejected lifecycle
// independent of the order's own status, which orderLifecycle.js's
// decideCancellationRequest coordinates against a fresh read of both.
//
// This module only owns the collection itself. Permission checks (is this
// actor the order's requester, is this actor a valid buyer for the site)
// live in orderLifecycle.js — the same separation already used between
// sites.js's own CRUD checks (isOwner) and orderLifecycle.js's own
// createOrder authorization (canCreateOrderForSite), which is a different
// question asked one layer up.
const REQUESTS_KEY = 'sitestock_cancellation_requests_v1';

function readList() {
  try {
    const raw = localStorage.getItem(REQUESTS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function writeList(list) {
  localStorage.setItem(REQUESTS_KEY, JSON.stringify(list));
  notify();
}

const listeners = new Set();
function notify() {
  listeners.forEach(fn => fn());
}

export function subscribeCancellationRequests(fn) {
  listeners.add(fn);
  fn();
  return () => listeners.delete(fn);
}

window.addEventListener('storage', e => {
  if (e.key === REQUESTS_KEY) notify();
});

function newId() {
  const rand = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `cr-${rand}`;
}

export function getCancellationRequests() {
  return readList();
}

export function getCancellationRequest(requestId) {
  return readList().find(r => r.id === requestId) || null;
}

export function getCancellationRequestsForOrder(orderId) {
  return readList().filter(r => r.orderId === orderId);
}

export function getPendingCancellationRequestForOrder(orderId) {
  return readList().find(r => r.orderId === orderId && r.status === 'pending') || null;
}

// One pending request per order at a time — the same "already a request for
// this pair?" guard community.js's requestToJoin/requestBuyerRole already
// use. Does not check WHO is asking or whether the order is actually in an
// eligible status — that's orderLifecycle.js's requestCancellation's job,
// which only calls this after its own checks already passed.
export function createCancellationRequest(orderId, communityId, siteId, requestedById, requestedBy, reason) {
  const list = readList();
  if (list.some(r => r.orderId === orderId && r.status === 'pending')) {
    return { ok: false, error: 'A cancellation request is already pending for this order.' };
  }
  const request = {
    id: newId(),
    orderId,
    communityId,
    siteId,
    requestedById,
    requestedBy,
    reason,
    status: 'pending',
    createdAt: Date.now(),
    decidedAt: null,
    decidedById: null,
    decidedBy: null,
    decisionReason: null,
  };
  list.push(request);
  writeList(list);
  return { ok: true, request };
}

// Pure data update — the caller (orderLifecycle.js) has already decided
// whether this decision is legal (request still pending, actor currently
// authorized, and for an approval, that the underlying order transition
// itself actually succeeded) before ever calling this.
export function updateCancellationRequestDecision(requestId, status, decidedById, decidedBy, decisionReason) {
  const list = readList();
  const idx = list.findIndex(r => r.id === requestId);
  if (idx === -1) return { ok: false, error: 'Cancellation request not found.' };
  list[idx] = {
    ...list[idx],
    status,
    decidedAt: Date.now(),
    decidedById,
    decidedBy,
    decisionReason: decisionReason || null,
  };
  writeList(list);
  return { ok: true, request: list[idx] };
}
