import { searchProducts, getBranchesForProduct, getAvailability, getCategoryIcon, formatPrice } from './data.js';
import { geocodePostcode } from './geo.js';
import { subscribe } from './store.js';
import { createOrder } from './orderLifecycle.js';
import { getActiveCommunityId, isApprovalRequired } from './community.js';
import { getCurrentUserId, getCurrentDisplayName } from './identity.js';
import { getActiveSitesForUser } from './sites.js';

const siteSelectPanel = document.getElementById('site-select-panel');
const workerSitesList = document.getElementById('worker-sites-list');
const searchInput = document.getElementById('search-input');
const resultsEl = document.getElementById('search-results');
const searchPanel = document.querySelector('.search-panel');
const workerActiveSiteLabel = document.getElementById('worker-active-site-label');
const workerChangeSiteBtn = document.getElementById('worker-change-site-btn');
const orderPanel = document.getElementById('order-panel');
const orderFormEl = document.getElementById('order-form');
const backBtn = document.getElementById('back-to-search');
const siteOrdersList = document.getElementById('site-orders-list');

let selectedProduct = null;
let selectedSite = null;
let latestOrders = [];

// A site must be chosen before the search panel is even reachable — this is
// what makes it impossible for a worker to submit an order without a real
// siteId, on top of the authorization check orderLifecycle.js's createOrder
// performs independently (see its header comment: a reference is never
// itself a permission, so that check exists regardless of what this UI
// allows, but gating the flow here keeps the common path from ever hitting
// it).
function showSiteSelect() {
  selectedSite = null;
  orderPanel.hidden = true;
  searchPanel.hidden = true;
  siteSelectPanel.hidden = false;
  renderSiteSelectList();
}

function renderSiteSelectList() {
  const communityId = getActiveCommunityId();
  const userId = getCurrentUserId();
  const sites = getActiveSitesForUser(communityId, userId);

  if (sites.length === 0) {
    workerSitesList.innerHTML = '<p class="empty-hint">You haven\'t been assigned to a site yet — ask your owner to add you to one.</p>';
    return;
  }

  workerSitesList.innerHTML = sites.map(s => `
    <button type="button" class="result-card" data-site-id="${s.id}">
      <span class="result-name">${s.name}</span>
      <span class="result-meta">${[s.address, s.postcode].filter(Boolean).join(' · ') || 'No address on file'}</span>
    </button>
  `).join('');

  workerSitesList.querySelectorAll('[data-site-id]').forEach(btn => {
    btn.addEventListener('click', () => chooseSite(sites.find(s => s.id === btn.dataset.siteId)));
  });
}

function chooseSite(site) {
  if (!site) return;
  selectedSite = site;
  siteSelectPanel.hidden = true;
  searchPanel.hidden = false;
  workerActiveSiteLabel.textContent = site.name;
  searchInput.value = '';
  resultsEl.innerHTML = '';
}

workerChangeSiteBtn.addEventListener('click', () => {
  closeOrderForm();
  showSiteSelect();
});

searchInput.addEventListener('input', () => {
  const results = searchProducts(searchInput.value);
  renderResults(results);
});

function renderResults(products) {
  if (!searchInput.value.trim()) {
    resultsEl.innerHTML = '';
    return;
  }
  if (products.length === 0) {
    resultsEl.innerHTML = `<p class="empty-hint">No matches. Try a different word, e.g. "cement" or "vest".</p>`;
    return;
  }
  resultsEl.innerHTML = products.map(p => `
    <button class="result-card" data-id="${p.id}">
      <span class="result-name">${p.name}</span>
      <span class="result-meta">${p.category} &middot; ${formatPrice(p.unitPrice)} per ${p.unit}</span>
    </button>
  `).join('');

  resultsEl.querySelectorAll('.result-card').forEach(btn => {
    btn.addEventListener('click', () => {
      const product = products.find(p => p.id === btn.dataset.id);
      openOrderForm(product);
    });
  });
}

function openOrderForm(product) {
  selectedProduct = product;
  searchPanel.hidden = true;
  orderPanel.hidden = false;

  if (product.variants) {
    renderVariantStep(product);
  } else {
    renderDetailsStep(product, null);
  }
}

function setBackAction(label, action) {
  backBtn.textContent = `← ${label}`;
  backBtn.onclick = action;
}

function renderVariantStep(product) {
  setBackAction('Back to search', closeOrderForm);

  orderFormEl.innerHTML = `
    <h2>${product.name}</h2>
    <p class="hint">${product.category}</p>

    <label class="field-label">Which size / type do you need?</label>
    <div class="variant-list">
      ${product.variants.map(v => `
        <button type="button" class="variant-option" data-variant="${v}">
          <span class="variant-option-radio" aria-hidden="true"></span>
          <span class="variant-option-label">${v}</span>
          <span class="variant-option-arrow" aria-hidden="true">&rarr;</span>
        </button>
      `).join('')}

      <button type="button" class="variant-option variant-option-custom" id="custom-size-toggle">
        <span class="variant-option-radio" aria-hidden="true">+</span>
        <span class="variant-option-label">None of these — enter a custom size</span>
        <span class="variant-option-arrow" aria-hidden="true">&rarr;</span>
      </button>
    </div>

    <div class="custom-size-form" id="custom-size-form" hidden>
      <label class="field-label" for="custom-size-input">Custom size / measurement</label>
      <input type="text" id="custom-size-input" class="text-input" placeholder="e.g. 2700 x 1200 x 15mm" />
      <p id="custom-size-error" class="form-status error" hidden>Please enter a size.</p>
      <button type="button" id="custom-size-continue" class="btn btn-primary btn-block">Continue</button>
    </div>
  `;

  orderFormEl.querySelectorAll('.variant-option:not(.variant-option-custom)').forEach(btn => {
    btn.addEventListener('click', () => {
      renderDetailsStep(product, btn.dataset.variant);
    });
  });

  const customToggle = document.getElementById('custom-size-toggle');
  const customForm = document.getElementById('custom-size-form');
  const customInput = document.getElementById('custom-size-input');
  const customError = document.getElementById('custom-size-error');

  customToggle.addEventListener('click', () => {
    customToggle.hidden = true;
    customForm.hidden = false;
    customInput.focus();
  });

  function submitCustomSize() {
    const value = customInput.value.trim();
    if (!value) {
      customError.hidden = false;
      return;
    }
    renderDetailsStep(product, value);
  }

  document.getElementById('custom-size-continue').addEventListener('click', submitCustomSize);
  customInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') submitCustomSize();
  });
}

function renderDetailsStep(product, variant, prefill = null) {
  setBackAction(
    product.variants ? 'Back to size selection' : 'Back to search',
    product.variants ? () => renderVariantStep(product) : closeOrderForm
  );

  orderFormEl.innerHTML = `
    <h2>${product.name}${variant ? ` &mdash; ${variant}` : ''}</h2>
    <p class="hint">${product.category} &middot; requesting as <strong>${getCurrentDisplayName() || 'Unknown'}</strong></p>

    <label class="field-label" for="qty-input">Quantity (${product.unit})</label>
    <input type="number" id="qty-input" class="text-input" min="1" value="${prefill ? prefill.quantity : 1}" />

    <label class="field-label" for="postcode-input">Deliver to postcode</label>
    <input type="text" id="postcode-input" class="text-input" placeholder="e.g. SW1A 1AA" value="${prefill ? prefill.deliveryPostcode : (selectedSite ? selectedSite.postcode : '')}" />

    <button id="find-source-btn" class="btn btn-primary btn-block">Find where to order this from</button>
    <p id="order-form-status" class="form-status"></p>
  `;

  document.getElementById('find-source-btn').addEventListener('click', () => goToSourceStep(product, variant));
}

async function goToSourceStep(product, variant) {
  const statusEl = document.getElementById('order-form-status');
  const qty = Number(document.getElementById('qty-input').value) || 1;
  const postcode = document.getElementById('postcode-input').value.trim();

  if (!postcode) {
    statusEl.textContent = 'Please enter a delivery postcode.';
    statusEl.className = 'form-status error';
    return;
  }

  statusEl.textContent = 'Looking up delivery postcode…';
  statusEl.className = 'form-status';

  const location = await geocodePostcode(postcode);
  if (!location) {
    statusEl.textContent = `Couldn't verify "${postcode}" — check it and try again.`;
    statusEl.className = 'form-status error';
    return;
  }

  const details = {
    quantity: qty,
    deliveryPostcode: postcode.toUpperCase(),
    deliveryLat: location.lat,
    deliveryLon: location.lon,
    requestedBy: getCurrentDisplayName() || 'Unknown',
    requestedById: getCurrentUserId(),
  };

  renderSourceStep(product, variant, details);
}

function renderSourceStep(product, variant, details) {
  setBackAction('Back to order details', () => {
    renderDetailsStep(product, variant, details);
  });

  const sources = getBranchesForProduct(product);

  orderFormEl.innerHTML = `
    <h2>${product.name}${variant ? ` &mdash; ${variant}` : ''}</h2>
    <p class="hint">${details.quantity} &times; ${product.unit} &middot; deliver to ${details.deliveryPostcode}</p>

    <label class="field-label">Where should this be ordered from?</label>
    <p class="hint">These are the stockists carrying this item, with how soon it'd be ready. Pick one to tell the driver where to buy it.</p>
    <div class="variant-list">
      ${sources.map(s => {
        const avail = getAvailability(s.id, product.id);
        return `
        <button type="button" class="variant-option source-option" data-branch-id="${s.id}">
          <span class="variant-option-radio" aria-hidden="true"></span>
          <span class="variant-option-label">
            <span class="source-name">${s.name}</span>
            <span class="source-meta">${s.website} &middot; ${s.postcode}</span>
            <span class="source-availability availability-${avail.key}">${avail.label}</span>
          </span>
          <span class="variant-option-arrow" aria-hidden="true">&rarr;</span>
        </button>
      `;
      }).join('')}
    </div>
  `;

  orderFormEl.querySelectorAll('.source-option').forEach(btn => {
    btn.addEventListener('click', () => {
      const branch = sources.find(s => s.id === btn.dataset.branchId);
      renderConfirmStep(product, variant, details, branch);
    });
  });
}

function renderConfirmStep(product, variant, details, branch) {
  setBackAction('Back to store selection', () => {
    renderSourceStep(product, variant, details);
  });

  const avail = getAvailability(branch.id, product.id);
  const websiteUrl = `https://${branch.website}`;

  orderFormEl.innerHTML = `
    <h2>Confirm this order</h2>

    <div class="product-preview">
      <div class="product-preview-icon" aria-hidden="true">${getCategoryIcon(product.category)}</div>
      <div class="product-preview-info">
        <strong>${product.name}${variant ? ` — ${variant}` : ''}</strong>
        <span>${details.quantity} &times; ${product.unit} &middot; ${product.category}</span>
        <span class="product-preview-price">${formatPrice(product.unitPrice)} per ${product.unit} &middot; ${formatPrice(product.unitPrice * details.quantity)} total</span>
      </div>
    </div>

    <div class="confirm-source-card">
      <div class="confirm-source-row">
        <span class="source-name">${branch.name}</span>
        <span class="availability-badge availability-${avail.key}">${avail.label}</span>
      </div>
      <span class="source-meta">${branch.website} &middot; ${branch.postcode}</span>
      <a class="link-btn" href="${websiteUrl}" target="_blank" rel="noopener noreferrer">Open ${branch.name.split(' - ')[0]}'s website &nearr;</a>
      <p class="hint small-hint">Opens their homepage in a new tab — this is a demo catalog, so it isn't linked to the exact product listing.</p>
    </div>

    <p class="hint">Delivering ${details.quantity} &times; ${product.unit} to <strong>${details.deliveryPostcode}</strong>.</p>

    <button id="confirm-order-btn" class="btn btn-primary btn-block">Confirm order</button>
  `;

  document.getElementById('confirm-order-btn').addEventListener('click', () => {
    submitOrder(product, variant, details, branch, avail);
  });
}

function submitOrder(product, variant, details, branch, avail) {
  const communityId = getActiveCommunityId();
  const approvalRequired = isApprovalRequired(communityId);

  const result = createOrder({
    communityId,
    siteId: selectedSite ? selectedSite.id : null,
    productId: product.id,
    productName: product.name,
    variant,
    quantity: details.quantity,
    unit: product.unit,
    deliveryPostcode: details.deliveryPostcode,
    deliveryLat: details.deliveryLat,
    deliveryLon: details.deliveryLon,
    requestedBy: details.requestedBy,
    requestedById: details.requestedById,
    stockistId: branch.id,
    stockistName: branch.name,
    stockistWebsite: branch.website,
    stockistPostcode: branch.postcode,
    pickupEstimate: avail ? avail.label : null,
    unitPrice: product.unitPrice,
    totalPrice: product.unitPrice * details.quantity,
  }, details.requestedById, details.requestedBy, approvalRequired);

  if (!result.ok) {
    alert(result.error);
    return;
  }

  orderFormEl.innerHTML = `
    <h2>Request sent</h2>
    <p class="hint">${product.name}${variant ? ` — ${variant}` : ''} from ${branch.name}, delivering to ${details.deliveryPostcode}. ${approvalRequired
      ? 'Waiting for the owner to approve it before a buyer can purchase it.'
      : 'It\'s gone straight to a buyer to purchase — this community doesn\'t require owner approval.'}</p>
  `;
  backBtn.hidden = true;

  setTimeout(() => {
    backBtn.hidden = false;
    closeOrderForm();
  }, 1400);
}

function closeOrderForm() {
  selectedProduct = null;
  orderPanel.hidden = true;
  searchPanel.hidden = false;
  searchInput.value = '';
  resultsEl.innerHTML = '';
}

const STATUS_LABELS = {
  pending_approval: 'Awaiting owner approval',
  rejected: 'Rejected by owner',
  pending_purchase: 'Waiting for a buyer to purchase',
  purchase_in_progress: 'Buyer confirming purchase…',
  purchased: 'Purchased — waiting for a driver',
  claimed: 'Driver assigned',
  collected: 'Collected — in transit',
  delivered: 'Delivered',
};

function renderSiteOrders() {
  const communityId = getActiveCommunityId();
  const sorted = latestOrders
    .filter(o => o.communityId === communityId)
    .sort((a, b) => b.createdAt - a.createdAt);
  if (sorted.length === 0) {
    siteOrdersList.innerHTML = '<p class="empty-hint">No orders placed yet.</p>';
    return;
  }
  siteOrdersList.innerHTML = sorted.map(o => `
    <div class="order-card status-${o.status}" data-order-id="${o.id}">
      <div class="order-card-main">
        <strong>${o.productName}${o.variant ? ` (${o.variant})` : ''}</strong>
        <span>${o.siteName ? `${o.siteName} &middot; ` : ''}${o.quantity} × ${o.unit} &middot; to ${o.deliveryPostcode}${o.totalPrice != null ? ` &middot; ${formatPrice(o.totalPrice)}` : ''}</span>
        ${o.stockistName ? `<span>From ${o.stockistName} (${o.stockistWebsite})</span>` : ''}
        ${o.status === 'rejected' && o.rejectionReason ? `<span class="rejection-reason">Reason: ${o.rejectionReason}</span>` : ''}
        ${o.status === 'delivered' && o.deliveryLocation ? `<span>Delivered to ${o.deliveryLocation} at ${new Date(o.deliveryTime).toLocaleString()}</span>` : ''}
      </div>
      <span class="status-badge status-${o.status}">${STATUS_LABELS[o.status] || o.status}</span>
    </div>
  `).join('');
}

export function refreshWorkerView() {
  closeOrderForm();
  showSiteSelect();
  renderSiteOrders();
}

subscribe(orders => {
  latestOrders = orders;
  renderSiteOrders();
});
