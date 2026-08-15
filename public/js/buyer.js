import { formatPrice, getCategoryIcon, getProduct } from './data.js';
import { subscribe } from './store.js';
import { getActiveCommunityId } from './community.js';
import { getCurrentUserId, getCurrentDisplayName } from './identity.js';
import { startPurchase, abandonPurchase, completePurchase, decideCancellationRequest } from './orderLifecycle.js';
import { canPurchaseForSite } from './sites.js';
import { getCancellationRequests, subscribeCancellationRequests } from './cancellationRequests.js';

const listPanel = document.getElementById('buyer-list-panel');
const listEl = document.getElementById('buyer-orders-list');
const detailPanel = document.getElementById('buyer-detail-panel');
const detailEl = document.getElementById('buyer-detail');
const backBtn = document.getElementById('buyer-back-btn');
const cancellationRequestsPanel = document.getElementById('buyer-cancellation-requests-panel');
const cancellationRequestsList = document.getElementById('buyer-cancellation-requests-list');

const HOLD_MS = 3000;

let latestOrders = [];
let selectedOrderId = null;
let holdState = null; // { startedAt, rafId, orderId } while a hold is in progress
let decidingRequestId = null;
let decidingAction = null; // 'approved' | 'rejected'

backBtn.addEventListener('click', () => {
  releaseHoldIfAny();
  showList();
});

function currentBuyerId() {
  return getCurrentUserId();
}

function currentBuyerName() {
  return getCurrentDisplayName() || 'Unnamed buyer';
}

function showList() {
  selectedOrderId = null;
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
        <span class="status-badge status-${order.status}">${order.status === 'claimed' ? 'Driver assigned' : 'Purchased — awaiting driver'}</span>
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

function handleCancelRequestAction(action, requestId) {
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
    const reasonInput = document.getElementById('cancel-decision-reason-input');
    const reason = reasonInput ? reasonInput.value.trim() : '';
    const result = decideCancellationRequest(requestId, decidingAction, currentBuyerId(), currentBuyerName(), reason || null);
    if (!result.ok) {
      // Do not fake success — e.g. a Driver may have collected the order
      // between the request and this decision, which the data layer refuses
      // deterministically. Show exactly what it returned.
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
    if (!stillPending && !holdState) {
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
  const btn = document.getElementById('hold-purchase-btn');
  const fill = document.getElementById('hold-purchase-fill');
  const label = document.getElementById('hold-purchase-label');
  const statusEl = document.getElementById('buyer-purchase-status');

  function begin() {
    if (holdState) return;
    const result = startPurchase(orderId, currentBuyerId(), currentBuyerName());
    if (!result.ok) {
      statusEl.textContent = result.error;
      statusEl.className = 'form-status error';
      return;
    }
    statusEl.textContent = '';
    statusEl.className = 'form-status';
    label.textContent = 'Keep holding…';
    const startedAt = performance.now();
    holdState = { startedAt, orderId };
    tick();
  }

  function tick() {
    if (!holdState) return;
    const elapsed = performance.now() - holdState.startedAt;
    const pct = Math.min(100, (elapsed / HOLD_MS) * 100);
    fill.style.width = `${pct}%`;
    if (elapsed >= HOLD_MS) {
      complete();
      return;
    }
    holdState.rafId = requestAnimationFrame(tick);
  }

  function complete() {
    if (!holdState) return;
    cancelAnimationFrame(holdState.rafId);
    holdState = null;
    const result = completePurchase(orderId, currentBuyerId(), currentBuyerName());
    if (!result.ok) {
      statusEl.textContent = result.error;
      statusEl.className = 'form-status error';
      fill.style.width = '0%';
      label.textContent = 'Press and hold to confirm Purchased';
      return;
    }
    label.textContent = 'Purchased ✓';
    statusEl.textContent = 'Confirmed — this order is now available to drivers.';
    statusEl.className = 'form-status success';
    setTimeout(showList, 1200);
  }

  function release() {
    if (!holdState) return;
    cancelAnimationFrame(holdState.rafId);
    holdState = null;
    fill.style.width = '0%';
    label.textContent = 'Press and hold to confirm Purchased';
    abandonPurchase(orderId, currentBuyerId(), currentBuyerName());
  }

  btn.addEventListener('pointerdown', begin);
  btn.addEventListener('pointerup', release);
  btn.addEventListener('pointerleave', release);
  btn.addEventListener('pointercancel', release);
}

function releaseHoldIfAny() {
  if (!holdState) return;
  const { orderId } = holdState;
  if (holdState.rafId) cancelAnimationFrame(holdState.rafId);
  holdState = null;
  abandonPurchase(orderId, currentBuyerId(), currentBuyerName());
}

export function refreshBuyerView(orderId = null) {
  releaseHoldIfAny();
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
