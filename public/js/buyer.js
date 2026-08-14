import { formatPrice, getCategoryIcon, getProduct } from './data.js';
import { subscribe } from './store.js';
import { getActiveCommunityId } from './community.js';
import { getCurrentUserId, getCurrentDisplayName } from './identity.js';
import { startPurchase, abandonPurchase, completePurchase } from './orderLifecycle.js';
import { canPurchaseForSite } from './sites.js';

const listPanel = document.getElementById('buyer-list-panel');
const listEl = document.getElementById('buyer-orders-list');
const detailPanel = document.getElementById('buyer-detail-panel');
const detailEl = document.getElementById('buyer-detail');
const backBtn = document.getElementById('buyer-back-btn');

const HOLD_MS = 3000;

let latestOrders = [];
let selectedOrderId = null;
let holdState = null; // { startedAt, rafId, orderId } while a hold is in progress

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
  const target = orderId && latestOrders.find(o => o.id === orderId && o.status === 'pending_purchase');
  if (target && visibleToCurrentBuyer(target)) {
    showDetail(orderId);
  } else {
    showList();
  }
}

subscribe(orders => {
  latestOrders = orders;
  render();
});
