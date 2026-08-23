import { formatPrice, getCategoryIcon } from './data.js';
import { getProduct } from './products.js';
import { getActiveCommunityId } from './community.js';
import { getCurrentUserId } from './identity.js';
import {
  subscribe, startPurchase, abandonPurchase, completePurchase, decideCancellationRequest,
  getCancellationRequests, subscribeCancellationRequests,
} from './orderLifecycle.js';
import { canPurchaseForSite } from './sites.js';
import { formatNeededBy } from './deadline.js';

const listPanel = document.getElementById('buyer-list-panel');
const listEl = document.getElementById('buyer-orders-list');
const detailPanel = document.getElementById('buyer-detail-panel');
const detailEl = document.getElementById('buyer-detail');
const backBtn = document.getElementById('buyer-back-btn');
const cancellationRequestsPanel = document.getElementById('buyer-cancellation-requests-panel');
const cancellationRequestsList = document.getElementById('buyer-cancellation-requests-list');

const HOLD_MS = 3000;

// Only the statuses a pending cancellation request can actually be shown
// against — purchased/claimed are the normal cases, collected covers the
// window between a driver collecting and the request auto-closing.
const CANCEL_REQUEST_STATUS_LABELS = {
  purchased: 'Purchased — awaiting driver',
  claimed: 'Driver assigned',
  collected: 'Collected — in transit',
};

let latestOrders = [];
let selectedOrderId = null;
let decidingRequestId = null;
let decidingAction = null; // 'approved' | 'rejected'

// --- Hold-to-confirm state machine ---------------------------------------
// idle -> starting -> holding -> completing -> done, with 'abandoning'
// reachable from 'holding' (a normal early release) or from 'starting' (a
// release that happened while startPurchase's RPC was still in flight —
// resolved once that RPC settles, see begin() below). Server state is
// authoritative throughout: the countdown never starts until startPurchase
// has actually succeeded server-side, and completePurchase/abandonPurchase
// are each called at most once per hold, guarded by the phase itself so a
// stray rAF frame or a duplicate pointer event can never double-fire either.
let holdPhase = 'idle';
let holdOrderId = null;
let holdStartedAt = null;
let holdRafId = null;
let releaseRequestedDuringStart = false;

// Bumped every time wireHoldButton() runs (a fresh detail render, whether
// for the same order revisited or a different one) and every time the
// Buyer leaves the detail view entirely (showList()). A begin()/complete()
// continuation captures the value current at wire time and compares against
// this later — if they no longer match, its own button/fill/label/statusEl
// references point at DOM the Buyer has since left, and any UI mutation is
// skipped (server-state handling still runs regardless; only DOM writes are
// guarded).
let holdGeneration = 0;

function holdInProgress() {
  return holdPhase !== 'idle';
}

backBtn.addEventListener('click', async () => {
  // releaseHoldIfAny() itself is phase-aware: it's a genuine, awaited
  // abandonPurchase call only when a hold is actively 'holding'; for
  // 'starting'/'completing' it just flags the in-flight begin()/complete()
  // continuation to clean up once its own RPC resolves, and never issues a
  // second, racing call against the same order (see wireHoldButton below).
  await releaseHoldIfAny();
  showList();
});

function currentBuyerId() {
  return getCurrentUserId();
}

function showList() {
  selectedOrderId = null;
  holdGeneration++; // invalidates any in-flight hold's DOM-touching continuation
  detailPanel.hidden = true;
  listPanel.hidden = false;
  render();
}

function showDetail(orderId) {
  selectedOrderId = orderId;
  listPanel.hidden = true;
  detailPanel.hidden = false;
  renderDetail();
}

// Buyer role alone is never enough — an order only belongs in this queue if
// the buyer is also a member of its site (or is the owner). This is checked
// fresh on every render, not just once when the list is built, so losing
// site access makes an order disappear from here immediately, the same way
// losing buyer access already does.
function visibleToCurrentBuyer(order) {
  return canPurchaseForSite(order.siteId, order.communityId, currentBuyerId());
}

// --- Phase 7C: cancellation-request decisions ---------------------------
// Visibility here mirrors the exact authorization decideCancellationRequest
// itself re-checks when a decision is actually made (canPurchaseForSite) —
// this list is a display convenience only; losing site/buyer access makes a
// request disappear from here immediately, and even if one were somehow
// still shown, the guarded function underneath would refuse it regardless.
function visibleCancellationRequests() {
  const communityId = getActiveCommunityId();
  const userId = currentBuyerId();
  return getCancellationRequests().filter(r => {
    if (r.communityId !== communityId || r.status !== 'pending') return false;
    const order = latestOrders.find(o => o.id === r.orderId);
    if (!order) return false;
    return canPurchaseForSite(order.siteId, order.communityId, userId);
  });
}

function renderCancellationRequests() {
  const pending = visibleCancellationRequests();
  cancellationRequestsPanel.hidden = pending.length === 0;
  if (pending.length === 0) return;

  cancellationRequestsList.innerHTML = pending.map(r => {
    const order = latestOrders.find(o => o.id === r.orderId);
    if (!order) return '';

    let actionHtml;
    if (decidingRequestId === r.id) {
      actionHtml = `
        <div class="reject-form">
          ${decidingAction === 'rejected'
            ? `<label class="field-label" for="cancel-decision-reason-input">Reason (optional)</label>
               <input type="text" id="cancel-decision-reason-input" class="text-input" placeholder="e.g. Already collecting this afternoon" />`
            : `<p class="hint small-hint">This cancels the order inside SiteStock — it doesn't process a refund or contact the supplier for you.</p>`}
          <div class="reject-form-actions">
            <button class="btn btn-secondary" data-cancel-action="never-mind" data-req-id="${r.id}">Never mind</button>
            <button class="btn btn-primary" data-cancel-action="confirm" data-req-id="${r.id}">${decidingAction === 'rejected' ? 'Confirm rejection' : 'Confirm cancellation'}</button>
          </div>
          <p id="cancel-decision-status" class="form-status"></p>
        </div>
      `;
    } else {
      actionHtml = `
        <div class="owner-actions">
          <button class="btn btn-secondary" data-cancel-action="start-reject" data-req-id="${r.id}">Reject</button>
          <button class="btn btn-primary" data-cancel-action="start-approve" data-req-id="${r.id}">Approve cancellation</button>
        </div>
      `;
    }

    return `
      <div class="order-card" data-order-id="${order.id}">
        <div class="order-card-main">
          <strong>${order.productName}${order.variant ? ` (${order.variant})` : ''}</strong>
          <span>${order.siteName ? `${order.siteName} &middot; ` : ''}${order.quantity} &times; ${order.unit} &middot; ${formatPrice(order.totalPrice)}</span>
          <span>Requested by ${r.requestedBy || 'Unknown'}</span>
        </div>
        <span class="status-badge status-${order.status}">${CANCEL_REQUEST_STATUS_LABELS[order.status] || order.status}</span>
        <p class="hint small-hint">Reason: ${r.reason}</p>
        ${actionHtml}
      </div>
    `;
  }).join('');

  cancellationRequestsList.querySelectorAll('[data-cancel-action]').forEach(btn => {
    btn.addEventListener('click', () => handleCancelRequestAction(btn.dataset.cancelAction, btn.dataset.reqId));
  });
  const reasonInput = cancellationRequestsList.querySelector('#cancel-decision-reason-input');
  if (reasonInput) reasonInput.focus();
}

let decisionInFlight = false;

async function handleCancelRequestAction(action, requestId) {
  if (action === 'start-approve') {
    decidingRequestId = requestId;
    decidingAction = 'approved';
    renderCancellationRequests();
    return;
  }
  if (action === 'start-reject') {
    decidingRequestId = requestId;
    decidingAction = 'rejected';
    renderCancellationRequests();
    return;
  }
  if (action === 'never-mind') {
    decidingRequestId = null;
    decidingAction = null;
    renderCancellationRequests();
    return;
  }
  if (action === 'confirm') {
    if (decisionInFlight) return;
    const reasonInput = document.getElementById('cancel-decision-reason-input');
    const reason = reasonInput ? reasonInput.value.trim() : '';
    decisionInFlight = true;
    const result = await decideCancellationRequest(requestId, decidingAction, reason || null);
    decisionInFlight = false;
    if (!result.ok) {
      // Do not fake success — e.g. a Driver may have collected the order
      // between the request and this decision, which the data layer refuses
      // deterministically (reconstructed from a fresh Supabase refetch, not
      // trusted from any stale local state). Show exactly what it returned.
      const statusEl = document.getElementById('cancel-decision-status');
      if (statusEl) {
        statusEl.textContent = result.error;
        statusEl.className = 'form-status error';
      }
      return;
    }
    decidingRequestId = null;
    decidingAction = null;
    renderCancellationRequests();
  }
}

// Mirrors main.js's highlightOrderIfPending, applied to this panel instead —
// a notification pointing at a cancellation request lands on an order that
// isn't in the main purchase queue, so refreshBuyerView's own detail-opening
// path doesn't apply here; this is the equivalent for this panel.
function highlightCancellationRequestForOrder(orderId) {
  requestAnimationFrame(() => {
    const el = cancellationRequestsList.querySelector(`[data-order-id="${orderId}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('order-card-highlight');
    setTimeout(() => el.classList.remove('order-card-highlight'), 2000);
  });
}

function render() {
  const communityId = getActiveCommunityId();
  const pending = latestOrders
    .filter(o => o.communityId === communityId && o.status === 'pending_purchase' && visibleToCurrentBuyer(o))
    .sort((a, b) => a.createdAt - b.createdAt);

  if (!detailPanel.hidden && selectedOrderId) {
    const stillPending = latestOrders.find(
      o => o.id === selectedOrderId && o.status === 'pending_purchase' && visibleToCurrentBuyer(o)
    );
    if (!stillPending && !holdInProgress()) {
      // Someone else purchased or claimed it, or we lost access to its site,
      // while we were looking — bounce back.
      showList();
      return;
    }
  }

  if (listPanel.hidden) return;

  if (pending.length === 0) {
    listEl.innerHTML = '<p class="empty-hint">Nothing waiting to be purchased right now.</p>';
    return;
  }

  listEl.innerHTML = pending.map(o => `
    <button class="result-card" data-id="${o.id}">
      <span class="result-name">${o.productName}${o.variant ? ` (${o.variant})` : ''}</span>
      <span class="result-meta">${o.siteName ? `${o.siteName} &middot; ` : ''}${o.quantity} &times; ${o.unit} &middot; ${formatPrice(o.totalPrice)} &middot; from ${o.stockistName || 'Unknown'}</span>
      <span class="result-meta order-needed-by">Needed by: ${formatNeededBy(o.neededByType, o.neededBy)}</span>
    </button>
  `).join('');

  listEl.querySelectorAll('.result-card').forEach(btn => {
    btn.addEventListener('click', () => showDetail(btn.dataset.id));
  });
}

function renderDetail() {
  const order = latestOrders.find(o => o.id === selectedOrderId);
  if (!order) {
    showList();
    return;
  }

  const websiteUrl = order.stockistWebsite ? `https://${order.stockistWebsite}` : null;
  const product = getProduct(order.productId);

  detailEl.innerHTML = `
    <h1>Review this order</h1>
    <div class="product-preview">
      <div class="product-preview-icon" aria-hidden="true">${product ? getCategoryIcon(product.category) : '📦'}</div>
      <div class="product-preview-info">
        <strong>${order.productName}${order.variant ? ` — ${order.variant}` : ''}</strong>
        <span>${order.quantity} &times; ${order.unit}</span>
        <span class="product-preview-price">${formatPrice(order.unitPrice)} per ${order.unit} &middot; ${formatPrice(order.totalPrice)} total</span>
      </div>
    </div>
    <p class="hint"><strong>Needed by:</strong> ${formatNeededBy(order.neededByType, order.neededBy)}</p>
    <div class="confirm-source-card">
      <div class="confirm-source-row">
        <span class="source-name">${order.stockistName || 'Unknown stockist'}</span>
      </div>
      <span class="source-meta">${order.stockistWebsite || ''} &middot; ${order.stockistPostcode || ''}</span>
      ${websiteUrl ? `<a class="link-btn" href="${websiteUrl}" target="_blank" rel="noopener noreferrer">Open ${order.stockistName.split(' - ')[0]}'s website &nearr;</a>` : ''}
    </div>
    <p class="hint">${order.siteName ? `For <strong>${order.siteName}</strong> — d` : 'D'}eliver to <strong>${order.deliveryPostcode}</strong>. Requested by ${order.requestedBy || 'Unknown'}.</p>
    <p class="hint small-hint">Buy this from the stockist above yourself, outside SiteStock — this app doesn't process the purchase. Once you've actually paid, come back here and press and hold the button below for 3 seconds to confirm.</p>

    <button type="button" class="btn btn-primary btn-block hold-confirm-btn" id="hold-purchase-btn">
      <span class="hold-confirm-fill" id="hold-purchase-fill"></span>
      <span class="hold-confirm-label" id="hold-purchase-label">Press and hold to confirm Purchased</span>
    </button>
    <p id="buyer-purchase-status" class="form-status"></p>
  `;

  wireHoldButton(order.id);
}

function wireHoldButton(orderId) {
  const myGeneration = ++holdGeneration;
  const btn = document.getElementById('hold-purchase-btn');
  const fill = document.getElementById('hold-purchase-fill');
  const label = document.getElementById('hold-purchase-label');
  const statusEl = document.getElementById('buyer-purchase-status');

  // False once the Buyer has left this exact render (list, a different
  // order, or this order re-rendered) — see holdGeneration's own comment.
  function isLive() {
    return myGeneration === holdGeneration;
  }

  function resetFill(text) {
    if (!isLive()) return;
    fill.style.width = '0%';
    label.textContent = text || 'Press and hold to confirm Purchased';
  }

  function setStatus(text, cls) {
    if (!isLive()) return;
    statusEl.textContent = text;
    statusEl.className = cls;
  }

  // Surfaces a failure regardless of whether this view is still live —
  // inline in the status line when it is; via alert() (the same pattern
  // owner.js/driver.js already use for a background action's failure) when
  // the Buyer has since navigated away and there's no live element to write
  // it into.
  function reportError(message) {
    if (isLive()) {
      setStatus(message, 'form-status error');
    } else {
      alert(message);
    }
  }

  // Only after the server has actually confirmed purchase_in_progress does
  // the deliberate 3-second hold begin — this is the requirement that
  // matters most here: no amount of holding the button counts for anything
  // until startPurchase has genuinely succeeded server-side.
  async function begin() {
    if (holdPhase !== 'idle') return; // buttons protected while an RPC is in flight
    holdPhase = 'starting';
    holdOrderId = orderId;
    releaseRequestedDuringStart = false;
    setStatus('', 'form-status');
    if (isLive()) label.textContent = 'Starting…';

    const result = await startPurchase(orderId);

    if (!result.ok) {
      holdPhase = 'idle';
      holdOrderId = null;
      resetFill();
      reportError(result.error);
      return;
    }

    if (releaseRequestedDuringStart) {
      // The Buyer let go — or navigated away entirely, which also sets
      // this flag via releaseHoldIfAny() below — before the server
      // confirmed. Either way there is now a genuine purchase_in_progress
      // lock server-side that nothing else will release; abandon it
      // exactly once. No DOM is touched if the view has since gone stale.
      releaseRequestedDuringStart = false;
      holdPhase = 'abandoning';
      resetFill();
      const abandonResult = await abandonPurchase(orderId);
      holdPhase = 'idle';
      holdOrderId = null;
      if (!abandonResult.ok) {
        // Do not pretend this succeeded — the order may still be
        // purchase_in_progress server-side. handleRpcFailure inside
        // abandonPurchase already refreshed the cache for the error codes
        // that matter; re-render so a still-live view reflects it.
        reportError(abandonResult.error);
        render();
      }
      return;
    }

    holdPhase = 'holding';
    if (isLive()) label.textContent = 'Keep holding…';
    holdStartedAt = performance.now();
    tick();
  }

  function tick() {
    if (holdPhase !== 'holding') return;
    const elapsed = performance.now() - holdStartedAt;
    if (isLive()) {
      const pct = Math.min(100, (elapsed / HOLD_MS) * 100);
      fill.style.width = `${pct}%`;
    }
    if (elapsed >= HOLD_MS) {
      // Set before calling complete() — this is what stops a second rAF
      // frame (or a pointerup arriving in the same tick) from ever
      // triggering a second completePurchase call for this hold.
      holdPhase = 'completing';
      complete();
      return;
    }
    holdRafId = requestAnimationFrame(tick);
  }

  async function complete() {
    if (holdRafId) cancelAnimationFrame(holdRafId);
    holdRafId = null;
    const result = await completePurchase(orderId);
    if (!result.ok) {
      holdPhase = 'idle';
      holdOrderId = null;
      resetFill();
      reportError(result.error);
      return;
    }
    holdPhase = 'done';
    if (isLive()) {
      label.textContent = 'Purchased ✓';
      statusEl.textContent = 'Confirmed — this order is now available to drivers.';
      statusEl.className = 'form-status success';
      setTimeout(showList, 1200);
    }
  }

  async function release() {
    if (holdPhase === 'starting') {
      // Can't abandon yet — no purchase_in_progress lock exists server-side
      // until startPurchase resolves. begin()'s own continuation (above)
      // checks this flag the moment it does, and is the only code path that
      // ever acts on it — avoids two independent completions racing to call
      // abandonPurchase for the same hold.
      releaseRequestedDuringStart = true;
      return;
    }
    if (holdPhase !== 'holding') return; // completing/abandoning/done/idle: nothing to do, never double-fire
    holdPhase = 'abandoning';
    if (holdRafId) cancelAnimationFrame(holdRafId);
    holdRafId = null;
    resetFill();
    const result = await abandonPurchase(orderId);
    holdPhase = 'idle';
    holdOrderId = null;
    if (!result.ok) {
      reportError(result.error);
      render();
    }
  }

  btn.addEventListener('pointerdown', begin);
  btn.addEventListener('pointerup', release);
  btn.addEventListener('pointerleave', release);
  btn.addEventListener('pointercancel', release);
}

async function releaseHoldIfAny() {
  if (holdPhase === 'starting') {
    releaseRequestedDuringStart = true;
    return;
  }
  if (holdPhase !== 'holding') return;
  const orderId = holdOrderId;
  holdPhase = 'abandoning';
  if (holdRafId) cancelAnimationFrame(holdRafId);
  holdRafId = null;
  const result = await abandonPurchase(orderId);
  holdPhase = 'idle';
  holdOrderId = null;
  if (!result.ok) {
    // No live hold-button DOM here — this runs from navigation (backBtn /
    // refreshBuyerView), not from the button itself. The order cache is
    // already refreshed for the error codes that matter (handleRpcFailure,
    // orderLifecycle.js); the caller's own next render picks up the truth.
    alert(result.error);
  }
}

export async function refreshBuyerView(orderId = null) {
  await releaseHoldIfAny();
  decidingRequestId = null;
  decidingAction = null;
  const target = orderId && latestOrders.find(o => o.id === orderId && o.status === 'pending_purchase');
  if (target && visibleToCurrentBuyer(target)) {
    showDetail(orderId);
  } else {
    showList();
    if (orderId) highlightCancellationRequestForOrder(orderId);
  }
  renderCancellationRequests();
}

subscribe(orders => {
  latestOrders = orders;
  render();
  renderCancellationRequests();
});

subscribeCancellationRequests(renderCancellationRequests);
