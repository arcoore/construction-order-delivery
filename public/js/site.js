import { getAvailability, getCategoryIcon, formatPrice, escapeHtml } from './data.js';
import { searchProducts, getProduct } from './products.js';
import { getBranchesForProduct } from './suppliers.js';
import { geocodePostcode, distanceKm } from './geo.js';
import {
  subscribe, createOrder, editOrder, cancelOrderDirect, requestCancellation,
  getPendingCancellationRequestForOrder, getCancellationRequestsForOrder, subscribeCancellationRequests,
  getOrderEvents, subscribeOrderEvents,
} from './orderLifecycle.js';
import { getActiveCommunityId, isApprovalRequired } from './community.js';
import { getCurrentUserId, getCurrentDisplayName } from './identity.js';
import { getActiveSitesForUser, subscribeSites } from './sites.js';
import {
  todayDeadlineDate, tomorrowDeadlineDate, isTodayDeadlineAvailable, cutoffTimeLabel,
  datetimeLocalToDate, dateToDatetimeLocalValue, formatNeededBy, neededByUrgency, urgencyLabel,
} from './deadline.js';
import { statusLabel, nextActionFor, describeEvent, itemsShortSummary, fulfilmentSummary } from './orderStatus.js';
import { renderOrderThread } from './orderThreadView.js';
import { subscribeOrderMessages, getMessageCountForOrder } from './orderMessages.js';
import { renderDeliveryPhotos } from './deliveryPhotosView.js';
import { getPhotoCountForOrder } from './deliveryPhotos.js';

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
// Multi-item (migration 0030). The Worker builds up an order by adding
// materials one at a time; each entry is { productId, productName, variant,
// unit, unitPrice, quantity }. Cleared only on a successful submit or an
// explicit "Clear order" — closing the add-material form keeps it, so you
// can add several. Order-level fields (site, postcode, needed-by, delivery
// method, supplier) are chosen once, after the cart is built.
let cart = [];

// Phase 7C — Worker corrections & cancellation UI. All of these are purely
// display-state; every action they lead to still calls the guarded Phase 7B
// functions (editOrder/cancelOrderDirect/requestCancellation), which
// independently re-check requestedById/membership/status themselves. Nothing
// here is itself a permission — it only decides what to *show*.
let editState = null; // { order, product, variant, quantity, deliveryPostcode, site, stockistId, stockistName, stockistWebsite, stockistPostcode, pickupEstimate, unitPrice, mode }
let cancellingOrderId = null;
let requestingCancelOrderId = null;

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

function cartBarHtml() {
  if (cart.length === 0) return '';
  const count = cart.reduce((n, it) => n + 1, 0);
  return `
    <div class="cart-bar" id="cart-bar">
      <span>${count} ${count === 1 ? 'material' : 'materials'} in this order</span>
      <div class="cart-bar-actions">
        <button type="button" class="link-btn" id="cart-clear-btn">Clear</button>
        <button type="button" class="btn btn-primary btn-small" id="cart-review-btn">Review order &rarr;</button>
      </div>
    </div>`;
}

function wireCartBar() {
  const clearBtn = document.getElementById('cart-clear-btn');
  if (clearBtn) clearBtn.addEventListener('click', () => { cart = []; renderResults(searchProducts(searchInput.value)); });
  const reviewBtn = document.getElementById('cart-review-btn');
  if (reviewBtn) reviewBtn.addEventListener('click', () => {
    searchPanel.hidden = true;
    orderPanel.hidden = false;
    renderDetailsStep(null);
  });
}

function renderResults(products) {
  const bar = cartBarHtml();
  if (!searchInput.value.trim()) {
    resultsEl.innerHTML = bar;
    wireCartBar();
    return;
  }
  if (products.length === 0) {
    resultsEl.innerHTML = bar + `<p class="empty-hint">No matches. Try a different word, e.g. "cement" or "vest".</p>`;
    wireCartBar();
    return;
  }
  resultsEl.innerHTML = bar + products.map(p => `
    <button class="result-card" data-id="${p.id}">
      <span class="result-name">${p.name}</span>
      <span class="result-meta">${p.category} &middot; ${formatPrice(p.unitPrice)} per ${p.unit}</span>
    </button>
  `).join('');
  wireCartBar();

  resultsEl.querySelectorAll('.result-card').forEach(btn => {
    btn.addEventListener('click', () => {
      const product = products.find(p => p.id === btn.dataset.id);
      openOrderForm(product);
    });
  });
}

function addToCart(product, variant, quantity) {
  cart.push({
    productId: product.id,
    productName: product.name,
    variant: variant || null,
    unit: product.unit,
    unitPrice: product.unitPrice,
    quantity,
  });
}

function openOrderForm(product) {
  selectedProduct = product;
  searchPanel.hidden = true;
  orderPanel.hidden = false;

  if (product.variants) {
    renderVariantStep(product);
  } else {
    renderQuantityStep(product, null);
  }
}

// Small step: just how many, then "Add to order" drops the line into the
// cart and returns to search so more can be added. Order-level details come
// later, once (renderDetailsStep).
function renderQuantityStep(product, variant) {
  setBackAction(
    product.variants ? 'Back to size selection' : 'Back to search',
    product.variants ? () => renderVariantStep(product) : backToSearchKeepingCart
  );
  orderFormEl.innerHTML = `
    <h2>${product.name}${variant ? ` &mdash; ${variant}` : ''}</h2>
    <p class="hint">${product.category} &middot; ${formatPrice(product.unitPrice)} per ${product.unit}</p>
    <label class="field-label" for="qty-input">How many (${product.unit})?</label>
    <input type="number" id="qty-input" class="text-input" min="1" value="1" />
    <button id="add-to-order-btn" class="btn btn-primary btn-block">Add to order</button>
    <p id="order-form-status" class="form-status"></p>
  `;
  document.getElementById('add-to-order-btn').addEventListener('click', () => {
    const qty = Number(document.getElementById('qty-input').value) || 1;
    if (qty <= 0) return;
    addToCart(product, variant, qty);
    backToSearchKeepingCart();
  });
}

function backToSearchKeepingCart() {
  selectedProduct = null;
  orderPanel.hidden = true;
  searchPanel.hidden = false;
  searchInput.value = '';
  renderResults([]);
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
      renderQuantityStep(product, btn.dataset.variant);
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
    renderQuantityStep(product, value);
  }

  document.getElementById('custom-size-continue').addEventListener('click', submitCustomSize);
  customInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') submitCustomSize();
  });
}

// --- Needed-by control (Roadmap Step 2) --------------------------------
// One control, one set of rules, shared between the create flow's details
// step and the edit flow's summary panel — never a second, different
// deadline UX for editing. onChange always receives the real stored shape
// ({ type: 'asap'|'deadline'|null, date: Date|null }) that
// orderLifecycle.js's createOrder/editOrder actually expect — 'today'/
// 'tomorrow' are UI-only button keys, resolved here into a real Date via
// deadline.js, and never themselves stored (see that module's header for
// why: a stored 'tomorrow' would go stale once real time moves past it).
function renderNeededByControl(current) {
  const time = cutoffTimeLabel();
  return `
    <label class="field-label">Needed by</label>
    <div class="needed-by-group" id="needed-by-group">
      <button type="button" class="needed-by-btn" data-needed-by="asap"><span class="needed-by-btn-label">ASAP</span></button>
      ${isTodayDeadlineAvailable() ? `<button type="button" class="needed-by-btn" data-needed-by="today"><span class="needed-by-btn-label">Today</span><span class="needed-by-btn-time">by ${time}</span></button>` : ''}
      <button type="button" class="needed-by-btn" data-needed-by="tomorrow"><span class="needed-by-btn-label">Tomorrow</span><span class="needed-by-btn-time">by ${time}</span></button>
      <button type="button" class="needed-by-btn" data-needed-by="custom"><span class="needed-by-btn-label">Choose date &amp; time</span></button>
    </div>
    <div class="needed-by-custom" id="needed-by-custom-form" hidden>
      <input type="datetime-local" id="needed-by-custom-input" class="text-input" min="${dateToDatetimeLocalValue(new Date())}" value="${current.type === 'deadline' && current.date ? dateToDatetimeLocalValue(current.date) : ''}" />
    </div>
    <p id="needed-by-error" class="form-status error" hidden>Please choose when this is needed by.</p>
  `;
}

// initialUiKey pre-highlights a button on first render only — 'asap' for an
// existing ASAP choice, 'custom' for any existing concrete deadline (we
// can't and don't need to know whether it originally came from Today/
// Tomorrow/a manual pick — the timestamp is all that's real; see above).
function wireNeededByControl(root, initialUiKey, onChange) {
  const group = root.querySelector('#needed-by-group');
  const customForm = root.querySelector('#needed-by-custom-form');
  const customInput = root.querySelector('#needed-by-custom-input');

  function setActive(uiKey) {
    group.querySelectorAll('.needed-by-btn').forEach(b => b.classList.toggle('active', b.dataset.neededBy === uiKey));
    customForm.hidden = uiKey !== 'custom';
  }
  if (initialUiKey) setActive(initialUiKey);

  function clearError() {
    const errorEl = root.querySelector('#needed-by-error');
    if (errorEl) errorEl.hidden = true;
  }

  group.querySelectorAll('.needed-by-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const kind = btn.dataset.neededBy;
      setActive(kind);
      clearError();
      if (kind === 'asap') onChange({ type: 'asap', date: null });
      else if (kind === 'today') onChange({ type: 'deadline', date: todayDeadlineDate() });
      else if (kind === 'tomorrow') onChange({ type: 'deadline', date: tomorrowDeadlineDate() });
      else if (kind === 'custom') onChange({ type: customInput.value ? 'deadline' : null, date: datetimeLocalToDate(customInput.value) });
    });
  });

  customInput.addEventListener('input', () => {
    clearError();
    onChange({ type: customInput.value ? 'deadline' : null, date: datetimeLocalToDate(customInput.value) });
  });
}

function neededByUiKeyFor(choice) {
  if (!choice) return null;
  if (choice.type === 'asap') return 'asap';
  if (choice.type === 'deadline') return 'custom';
  return null;
}

function isNeededByChoiceValid(choice) {
  return !!choice && !!choice.type && (choice.type !== 'deadline' || !!choice.date);
}

// Order-level details, chosen once for everything in the cart: delivery
// postcode, needed-by, delivery method. Also shows the cart contents with
// per-line remove, and a way back to search to add more.
function renderDetailsStep(prefill = null) {
  if (cart.length === 0) { backToSearchKeepingCart(); return; }
  setBackAction('Back to search', backToSearchKeepingCart);

  let neededByChoice = prefill && prefill.neededByType
    ? { type: prefill.neededByType, date: prefill.neededByMs != null ? new Date(prefill.neededByMs) : null }
    : { type: null, date: null };

  orderFormEl.innerHTML = `
    <h2>Your order &mdash; ${cart.length} ${cart.length === 1 ? 'material' : 'materials'}</h2>
    <p class="hint">Requesting as <strong>${getCurrentDisplayName() || 'Unknown'}</strong></p>

    <ul class="order-items-list" id="cart-items">
      ${cart.map((it, i) => `<li>${it.quantity} &times; ${it.unit} ${it.productName}${it.variant ? ` (${it.variant})` : ''} <button type="button" class="link-btn" data-remove-item="${i}">Remove</button></li>`).join('')}
    </ul>
    <button type="button" class="link-btn" id="add-more-btn">+ Add another material</button>

    <label class="field-label" for="postcode-input">Deliver to postcode</label>
    <input type="text" id="postcode-input" class="text-input" placeholder="e.g. SW1A 1AA" value="${prefill ? prefill.deliveryPostcode : (selectedSite ? selectedSite.postcode : '')}" />

    ${renderNeededByControl(neededByChoice)}

    <label class="field-label">Delivery</label>
    <div class="role-toggle-group" id="delivery-method-group">
      <button type="button" class="role-toggle-btn${(prefill ? prefill.deliveryMethod : 'driver') !== 'direct_supplier' ? ' active' : ''}" data-delivery-method="driver">A driver collects &amp; delivers it</button>
      <button type="button" class="role-toggle-btn${(prefill ? prefill.deliveryMethod : 'driver') === 'direct_supplier' ? ' active' : ''}" data-delivery-method="direct_supplier">The supplier delivers direct to site</button>
    </div>

    <button id="find-source-btn" class="btn btn-primary btn-block">Find where to order from</button>
    <p id="order-form-status" class="form-status"></p>
  `;

  orderFormEl.querySelectorAll('[data-remove-item]').forEach(btn => {
    btn.addEventListener('click', () => {
      cart.splice(Number(btn.dataset.removeItem), 1);
      if (cart.length === 0) { backToSearchKeepingCart(); return; }
      renderDetailsStep(prefill);
    });
  });
  document.getElementById('add-more-btn').addEventListener('click', backToSearchKeepingCart);

  wireNeededByControl(orderFormEl, neededByUiKeyFor(neededByChoice), choice => { neededByChoice = choice; });

  let deliveryMethod = (prefill && prefill.deliveryMethod) || 'driver';
  const deliveryMethodGroup = document.getElementById('delivery-method-group');
  deliveryMethodGroup.addEventListener('click', e => {
    const btn = e.target.closest('[data-delivery-method]');
    if (!btn) return;
    deliveryMethod = btn.dataset.deliveryMethod;
    deliveryMethodGroup.querySelectorAll('[data-delivery-method]').forEach(b => b.classList.toggle('active', b === btn));
  });

  document.getElementById('find-source-btn').addEventListener('click', () => goToSourceStep(neededByChoice, deliveryMethod));
}

async function goToSourceStep(neededByChoice, deliveryMethod) {
  const statusEl = document.getElementById('order-form-status');
  const postcode = document.getElementById('postcode-input').value.trim();

  if (!isNeededByChoiceValid(neededByChoice)) {
    const errorEl = document.getElementById('needed-by-error');
    if (errorEl) errorEl.hidden = false;
    return;
  }

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
    deliveryPostcode: postcode.toUpperCase(),
    deliveryLat: location.lat,
    deliveryLon: location.lon,
    requestedBy: getCurrentDisplayName() || 'Unknown',
    requestedById: getCurrentUserId(),
    neededByType: neededByChoice.type,
    neededBy: neededByChoice.date ? neededByChoice.date.getTime() : null,
    deliveryMethod: deliveryMethod || 'driver',
  };

  renderSourceStep(details);
}

// Phase A — honest, distance-only supplier ranking. Real straight-line
// (haversine) distance from the Site's already-geocoded delivery coordinate
// to each candidate branch, nearest first — the only ranking factor here,
// since price/availability are still demo/static data (see data.js) and
// would be dishonest to rank on. Never mutates the shared BRANCHES fixture
// or product.branchIds — always maps to new objects. A branch (or,
// defensively, a missing delivery coordinate — shouldn't happen given
// goToSourceStep already blocks on a failed geocode, but checked anyway)
// without a usable coordinate sorts last, labeled "Distance unavailable"
// rather than showing NaN or silently pretending a distance was computed.
// Array.prototype.sort is stable (ES2019+), so equal/unavailable distances
// naturally fall back to the existing catalog order — no secondary sort key
// needed.
function rankBranchesByDistance(branches, details) {
  const origin = (details.deliveryLat != null && details.deliveryLon != null)
    ? { lat: details.deliveryLat, lon: details.deliveryLon }
    : null;
  return branches
    .map(branch => ({
      ...branch,
      distanceKm: (origin && branch.lat != null && branch.lon != null)
        ? distanceKm(origin, branch)
        : null,
    }))
    .sort((a, b) => {
      if (a.distanceKm == null && b.distanceKm == null) return 0;
      if (a.distanceKm == null) return 1;
      if (b.distanceKm == null) return -1;
      return a.distanceKm - b.distanceKm;
    });
}

// One supplier for the whole order. Branch ranking uses the first cart
// item's product as the representative — multi-supplier-per-order is
// deliberately out of scope (see migration 0030's header).
function renderSourceStep(details) {
  setBackAction('Back to order details', () => renderDetailsStep(details));

  const repProduct = getProduct(cart[0] ? cart[0].productId : null);
  if (!repProduct) { alert('That material is no longer in the catalog.'); backToSearchKeepingCart(); return; }
  const sources = rankBranchesByDistance(getBranchesForProduct(repProduct), details);

  orderFormEl.innerHTML = `
    <h2>Where should this be ordered from?</h2>
    <p class="hint">${cart.length} ${cart.length === 1 ? 'material' : 'materials'} &middot; deliver to ${escapeHtml(details.deliveryPostcode)}</p>
    <p class="hint">Sorted by distance from this site, nearest first. Availability shown below is a demo estimate, not live stock — pick one to tell the driver where to buy it.</p>
    <div class="variant-list">
      ${sources.map(s => {
        const avail = getAvailability(s.id, repProduct.id);
        return `
        <button type="button" class="variant-option source-option" data-branch-id="${s.id}">
          <span class="variant-option-radio" aria-hidden="true"></span>
          <span class="variant-option-label">
            <span class="source-name">${s.name}</span>
            <span class="source-meta">${s.website} &middot; ${s.postcode}</span>
            <span class="source-distance">${s.distanceKm != null ? `~${s.distanceKm.toFixed(1)} km from site` : 'Distance unavailable'}</span>
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
      renderConfirmStep(details, branch, getAvailability(branch.id, repProduct.id));
    });
  });
}

function renderConfirmStep(details, branch, avail) {
  setBackAction('Back to store selection', () => renderSourceStep(details));

  const websiteUrl = `https://${branch.website}`;
  const total = cart.reduce((sum, it) => sum + (it.unitPrice || 0) * it.quantity, 0);

  orderFormEl.innerHTML = `
    <h2>Confirm this order</h2>

    <ul class="order-items-list">
      ${cart.map(it => `<li>${escapeHtml(it.quantity)} &times; ${escapeHtml(it.unit)} ${escapeHtml(it.productName)}${it.variant ? ` (${escapeHtml(it.variant)})` : ''} &middot; ${formatPrice((it.unitPrice || 0) * it.quantity)}</li>`).join('')}
    </ul>
    <p class="hint"><strong>Total: ${formatPrice(total)}</strong></p>

    <div class="confirm-source-card">
      <div class="confirm-source-row">
        <span class="source-name">${escapeHtml(branch.name)}</span>
        <span class="availability-badge availability-${avail.key}">${avail.label}</span>
      </div>
      <span class="source-meta">${escapeHtml(branch.website)} &middot; ${escapeHtml(branch.postcode)}</span>
      <a class="link-btn" href="${escapeHtml(websiteUrl)}" target="_blank" rel="noopener noreferrer">Open ${escapeHtml(branch.name.split(' - ')[0])}'s website &nearr;</a>
      <p class="hint small-hint">Opens their homepage in a new tab — this is a demo catalog, so it isn't linked to the exact product listing.</p>
    </div>

    <p class="hint">Delivering to <strong>${escapeHtml(details.deliveryPostcode)}</strong>.</p>
    <p class="hint"><strong>Needed by:</strong> ${formatNeededBy(details.neededByType, details.neededBy)}</p>
    <p class="hint"><strong>Delivery:</strong> ${details.deliveryMethod === 'direct_supplier' ? 'Supplier delivers direct to site' : 'A driver collects & delivers it'}</p>

    <button id="confirm-order-btn" class="btn btn-primary btn-block">Confirm order</button>
  `;

  const confirmBtn = document.getElementById('confirm-order-btn');
  confirmBtn.addEventListener('click', () => submitOrder(details, branch, avail, confirmBtn));
}

async function submitOrder(details, branch, avail, confirmBtn) {
  const communityId = getActiveCommunityId();

  confirmBtn.disabled = true;
  const result = await createOrder({
    communityId,
    siteId: selectedSite ? selectedSite.id : null,
    items: cart.map(it => ({ ...it })),
    deliveryPostcode: details.deliveryPostcode,
    deliveryLat: details.deliveryLat,
    deliveryLon: details.deliveryLon,
    stockistId: branch.id,
    stockistName: branch.name,
    stockistWebsite: branch.website,
    stockistPostcode: branch.postcode,
    pickupEstimate: avail ? avail.label : null,
    neededByType: details.neededByType,
    neededBy: details.neededBy,
    deliveryMethod: details.deliveryMethod,
  });

  if (!result.ok) {
    confirmBtn.disabled = false;
    alert(result.error);
    return;
  }

  const stillApprovalRequired = result.order.approvalWasRequired;
  cart = [];
  orderFormEl.innerHTML = `
    <h2>Request sent</h2>
    <p class="hint">${itemsShortSummary(result.order)} from ${escapeHtml(branch.name)}, delivering to ${escapeHtml(details.deliveryPostcode)}. ${stillApprovalRequired
      ? 'Waiting for the owner to approve it before a buyer can purchase it.'
      : 'It\'s gone straight to a buyer to purchase — this company doesn\'t require owner approval.'}</p>
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

// Roadmap Step 4 — which of the Worker's own order cards currently has its
// inline history/timeline expanded. Purely UI state, like editState/
// cancellingOrderId above — never touches the guarded lifecycle functions,
// and is reset (along with them) whenever the Worker view is refreshed.
let expandedHistoryIds = new Set();

// --- Phase 7C: Worker corrections & cancellation UI -------------------

// A pure UI mirror of the zones editOrder()/cancelOrderDirect() already
// enforce — used only to decide what buttons to show. The real gate is
// always the guarded function itself, called fresh when a button is
// actually pressed, never this predicate.
function canEditOrCancelDirectly(order) {
  return order.status === 'pending_approval' || order.status === 'pending_purchase';
}

function canRequestCancellation(order) {
  // Migration 0035 — 'collected' is now allowed too; the Buyer's approval
  // then asks the driver to arrange the return. 'delivered' stays out.
  return order.status === 'purchased' || order.status === 'claimed' || order.status === 'collected';
}

function cancellationStateHint(order) {
  if (order.status === 'cancelled') return '';
  const pending = getPendingCancellationRequestForOrder(order.id);
  if (pending) {
    return `<p class="hint small-hint">Cancellation requested — awaiting Buyer decision.</p>`;
  }
  const history = getCancellationRequestsForOrder(order.id);
  const latest = history.length ? history.reduce((a, b) => (a.createdAt > b.createdAt ? a : b)) : null;
  if (latest && latest.status === 'rejected') {
    return `<p class="hint small-hint">Cancellation rejected${latest.decisionReason ? `: ${escapeHtml(latest.decisionReason)}` : "."}</p>`;
  }
  return '';
}

function renderWorkerActions(order) {
  if (order.requestedById !== getCurrentUserId()) return '';

  if (cancellingOrderId === order.id) return renderCancelHoldForm(order);
  if (requestingCancelOrderId === order.id) return renderRequestCancelForm(order);

  if (canEditOrCancelDirectly(order)) {
    return `
      <div class="owner-actions">
        <button type="button" class="btn btn-secondary" data-worker-action="cancel" data-id="${order.id}">Cancel order</button>
        <button type="button" class="btn btn-primary" data-worker-action="edit" data-id="${order.id}">Edit order</button>
      </div>
    `;
  }

  if (canRequestCancellation(order) && !getPendingCancellationRequestForOrder(order.id)) {
    return `
      <div class="owner-actions">
        <button type="button" class="btn btn-secondary" data-worker-action="request-cancel" data-id="${order.id}">Request cancellation</button>
      </div>
    `;
  }

  return '';
}

function renderCancelHoldForm() {
  return `
    <div class="reject-form">
      <p class="hint small-hint">This stops the order inside SiteStock — it won't be approved, purchased, or delivered.</p>
      <button type="button" class="btn btn-primary btn-block hold-confirm-btn" id="hold-cancel-btn">
        <span class="hold-confirm-fill" id="hold-cancel-fill"></span>
        <span class="hold-confirm-label" id="hold-cancel-label">Press and hold to cancel</span>
      </button>
      <p id="worker-cancel-status" class="form-status"></p>
      <button type="button" class="link-btn" data-worker-action="cancel-never-mind">Never mind</button>
    </div>
  `;
}

function renderRequestCancelForm(order) {
  return `
    <div class="reject-form">
      <label class="field-label" for="request-cancel-reason-input">Why do you want to cancel? (required)</label>
      <input type="text" id="request-cancel-reason-input" class="text-input" placeholder="e.g. Site plan changed, no longer needed" />
      <p class="hint small-hint">This has already been purchased, so it sends a request to the Buyer to decide — it doesn't automatically refund or cancel anything with the supplier.${order.status === 'collected' ? ' The driver has already collected it, so if approved they\'ll be asked to arrange the return.' : ''}</p>
      <div class="reject-form-actions">
        <button class="btn btn-secondary" data-worker-action="request-cancel-never-mind" data-id="${order.id}">Never mind</button>
        <button class="btn btn-primary" data-worker-action="request-cancel-submit" data-id="${order.id}">Send request</button>
      </div>
      <p id="worker-request-cancel-status" class="form-status"></p>
    </div>
  `;
}

function wireCancelHoldButton(orderId) {
  const btn = document.getElementById('hold-cancel-btn');
  if (!btn) return;
  const fill = document.getElementById('hold-cancel-fill');
  const label = document.getElementById('hold-cancel-label');
  const statusEl = document.getElementById('worker-cancel-status');
  const HOLD_MS = 3000;
  let startedAt = null;
  let rafId = null;

  function tick() {
    if (startedAt == null) return;
    const elapsed = performance.now() - startedAt;
    fill.style.width = `${Math.min(100, (elapsed / HOLD_MS) * 100)}%`;
    if (elapsed >= HOLD_MS) {
      complete();
      return;
    }
    rafId = requestAnimationFrame(tick);
  }

  function begin() {
    if (startedAt != null) return;
    label.textContent = 'Keep holding…';
    startedAt = performance.now();
    tick();
  }

  // Unlike the Buyer's purchase hold, nothing is called at pointerdown —
  // cancelOrderDirect is a single atomic action with no "in progress" state
  // in the data layer (there's no data-layer lock to abandon on release),
  // so it's only ever called once, right at the moment the hold completes.
  // `completing` guards against tick()'s rAF re-entering complete() a
  // second time while the RPC is still in flight.
  let completing = false;
  async function complete() {
    if (startedAt == null || completing) return;
    completing = true;
    cancelAnimationFrame(rafId);
    startedAt = null;
    const result = await cancelOrderDirect(orderId, null);
    completing = false;
    if (!result.ok) {
      statusEl.textContent = result.error;
      statusEl.className = 'form-status error';
      fill.style.width = '0%';
      label.textContent = 'Press and hold to cancel';
      return;
    }
    cancellingOrderId = null;
    renderSiteOrders();
  }

  function release() {
    if (startedAt == null) return;
    cancelAnimationFrame(rafId);
    startedAt = null;
    fill.style.width = '0%';
    label.textContent = 'Press and hold to cancel';
  }

  btn.addEventListener('pointerdown', begin);
  btn.addEventListener('pointerup', release);
  btn.addEventListener('pointerleave', release);
  btn.addEventListener('pointercancel', release);
}

async function handleWorkerAction(action, orderId) {
  if (action === 'edit') {
    const order = latestOrders.find(o => o.id === orderId);
    if (order) openEditForm(order);
    return;
  }
  if (action === 'cancel') {
    cancellingOrderId = orderId;
    renderSiteOrders();
    return;
  }
  if (action === 'cancel-never-mind') {
    cancellingOrderId = null;
    renderSiteOrders();
    return;
  }
  if (action === 'request-cancel') {
    requestingCancelOrderId = orderId;
    renderSiteOrders();
    return;
  }
  if (action === 'request-cancel-never-mind') {
    requestingCancelOrderId = null;
    renderSiteOrders();
    return;
  }
  if (action === 'request-cancel-submit') {
    const input = document.getElementById('request-cancel-reason-input');
    const reason = input ? input.value.trim() : '';
    if (!reason) {
      if (input) input.focus();
      return;
    }
    const submitBtn = document.querySelector('[data-worker-action="request-cancel-submit"]');
    if (submitBtn) submitBtn.disabled = true;
    const result = await requestCancellation(orderId, reason);
    if (!result.ok) {
      if (submitBtn) submitBtn.disabled = false;
      const statusEl = document.getElementById('worker-request-cancel-status');
      if (statusEl) {
        statusEl.textContent = result.error;
        statusEl.className = 'form-status error';
      }
      return;
    }
    requestingCancelOrderId = null;
    renderSiteOrders();
  }
}

// --- Edit flow ----------------------------------------------------------
// A compact, single-panel edit form rather than re-running the full
// creation wizard as separate screens — reuses the exact same underlying
// data (searchProducts/getBranchesForProduct/getAvailability) and the same
// picker markup patterns (.result-card/.variant-list/.variant-option/
// .source-option), just laid out as progressive reveal within one panel.
// Every value collected here only ever reaches the order via editOrder()'s
// own field whitelist and re-authorization — this form cannot bypass that.

function openEditForm(order) {
  // Multi-item (migration 0030): editState.items is the working copy of the
  // order's line items — { productId, productName, variant, unit, unitPrice,
  // quantity }. editIndex is which item the material/variant picker is
  // currently targeting ('new' appends).
  editState = {
    order,
    items: (order.items || []).map(it => ({
      productId: it.productId, productName: it.productName, variant: it.variant,
      unit: it.unit, unitPrice: it.unitPrice, quantity: it.quantity,
    })),
    editIndex: null,
    pickProduct: null,
    deliveryPostcode: order.deliveryPostcode,
    site: { id: order.siteId, name: order.siteName, address: order.siteAddress, postcode: order.sitePostcode },
    stockistId: order.stockistId,
    stockistName: order.stockistName,
    stockistWebsite: order.stockistWebsite,
    stockistPostcode: order.stockistPostcode,
    pickupEstimate: order.pickupEstimate,
    neededByType: order.neededByType,
    neededBy: order.neededBy,
    mode: 'summary',
  };
  siteSelectPanel.hidden = true;
  searchPanel.hidden = true;
  orderPanel.hidden = false;
  setBackAction('Back to my orders', closeEditForm);
  renderEditForm();
}

function closeEditForm() {
  editState = null;
  orderPanel.hidden = true;
  showSiteSelect();
}

// Messaging opens in the dedicated order panel (like the edit form) rather
// than inline in the order list, so a background list re-render can never
// wipe an in-progress message.
let messagesOrderId = null;
function openMessagesPanel(orderId) {
  messagesOrderId = orderId;
  siteSelectPanel.hidden = true;
  searchPanel.hidden = true;
  orderPanel.hidden = false;
  setBackAction('Back to my orders', closeMessagesPanel);
  const order = latestOrders.find(o => o.id === orderId);
  orderFormEl.innerHTML = `
    <h1>Messages</h1>
    <p class="hint">${order ? itemsShortSummary(order) : 'this order'}</p>
    ${getPhotoCountForOrder(orderId) ? '<h2>Delivery photos</h2><div id="worker-order-photos"></div>' : ''}
    <div id="worker-order-thread"></div>
  `;
  renderOrderThread(document.getElementById('worker-order-thread'), orderId);
  const photosEl = document.getElementById('worker-order-photos');
  if (photosEl) renderDeliveryPhotos(photosEl, orderId, { canUpload: false });
}
function closeMessagesPanel() {
  messagesOrderId = null;
  orderPanel.hidden = true;
  showSiteSelect();
}

function renderEditForm() {
  if (!editState) return;
  if (editState.mode === 'pick-material') return renderEditPickMaterial();
  if (editState.mode === 'pick-variant') return renderEditPickVariant();
  if (editState.mode === 'pick-item-qty') return renderEditPickItemQty();
  if (editState.mode === 'pick-source') return renderEditPickSource();
  if (editState.mode === 'pick-site') return renderEditPickSite();
  return renderEditSummary();
}

// Commits editState.pickProduct + editState.pickVariant + a quantity into
// editState.items at editState.editIndex ('new' appends), then back to
// summary. Shared by the change-an-item and add-an-item paths.
function renderEditPickItemQty() {
  const p = editState.pickProduct;
  const v = editState.pickVariant || null;
  const existing = editState.editIndex !== 'new' ? editState.items[editState.editIndex] : null;
  const startQty = existing && existing.productId === p.id ? existing.quantity : 1;
  orderFormEl.innerHTML = `
    <h2>${p.name}${v ? ` &mdash; ${v}` : ''}</h2>
    <label class="field-label" for="edit-item-qty-input">How many (${p.unit})?</label>
    <input type="number" id="edit-item-qty-input" class="text-input" min="1" value="${startQty}" />
    <button type="button" id="edit-item-qty-continue" class="btn btn-primary btn-block">${editState.editIndex === 'new' ? 'Add to order' : 'Update material'}</button>
    <button type="button" class="link-btn" id="edit-item-qty-cancel">Cancel</button>
  `;
  document.getElementById('edit-item-qty-continue').addEventListener('click', () => {
    const q = Number(document.getElementById('edit-item-qty-input').value) || 1;
    if (q <= 0) return;
    const entry = { productId: p.id, productName: p.name, variant: v, unit: p.unit, unitPrice: p.unitPrice, quantity: q };
    if (editState.editIndex === 'new') editState.items.push(entry);
    else editState.items[editState.editIndex] = entry;
    editState.pickProduct = null;
    editState.pickVariant = null;
    editState.mode = 'summary';
    renderEditForm();
  });
  document.getElementById('edit-item-qty-cancel').addEventListener('click', () => {
    editState.mode = 'summary';
    renderEditForm();
  });
}

// Pull the current quantity inputs back into editState.items before any
// navigation away from the summary, so a qty change isn't lost when the
// Worker taps "Change" or "Add material".
function syncEditQuantities() {
  orderFormEl.querySelectorAll('[data-edit-qty]').forEach(inp => {
    const i = Number(inp.dataset.editQty);
    const q = Number(inp.value) || 0;
    if (editState.items[i] && q > 0) editState.items[i].quantity = q;
  });
}

function renderEditSummary() {
  const s = editState;
  const willReapprove = !!s.order.approvedById;

  orderFormEl.innerHTML = `
    <h2>Edit order</h2>

    <label class="field-label">Materials</label>
    <ul class="order-items-list edit-items-list">
      ${s.items.map((it, i) => `
        <li>
          <span>${it.productName}${it.variant ? ` (${it.variant})` : ''}</span>
          <input type="number" class="text-input edit-item-qty" min="1" value="${it.quantity}" data-edit-qty="${i}" aria-label="Quantity for ${it.productName}" />
          <span class="edit-item-unit">${it.unit}</span>
          <button type="button" class="link-btn" data-edit-change="${i}">Change</button>
          ${s.items.length > 1 ? `<button type="button" class="link-btn link-btn-danger" data-edit-remove="${i}">Remove</button>` : ''}
        </li>
      `).join('')}
    </ul>
    <button type="button" class="link-btn" id="edit-add-item-btn">+ Add another material</button>

    <div class="confirm-source-card">
      <div class="confirm-source-row"><span class="source-name">${s.stockistName || 'No stockist chosen yet'}</span></div>
      <button type="button" class="link-btn" id="edit-change-source-btn">Change stockist</button>
    </div>

    <label class="field-label">Site</label>
    <div class="confirm-source-card">
      <div class="confirm-source-row"><span class="source-name">${s.site.name || 'No site chosen'}</span></div>
      <span class="source-meta">${[s.site.address, s.site.postcode].filter(Boolean).join(' · ')}</span>
      <button type="button" class="link-btn" id="edit-change-site-btn">Change site</button>
    </div>

    <label class="field-label" for="edit-postcode-input">Deliver to postcode</label>
    <input type="text" id="edit-postcode-input" class="text-input" value="${s.deliveryPostcode}" />

    ${renderNeededByControl({ type: s.neededByType, date: s.neededBy != null ? new Date(s.neededBy) : null })}

    ${willReapprove ? `<p class="hint small-hint edit-reapproval-note">Changing this order will require the Owner to approve it again.</p>` : ''}

    <button type="button" id="edit-save-btn" class="btn btn-primary btn-block">Save changes</button>
    <p id="edit-form-status" class="form-status"></p>
  `;

  wireNeededByControl(
    orderFormEl,
    neededByUiKeyFor({ type: s.neededByType }),
    choice => { editState.neededByType = choice.type; editState.neededBy = choice.date ? choice.date.getTime() : null; }
  );

  orderFormEl.querySelectorAll('[data-edit-change]').forEach(btn => btn.addEventListener('click', () => {
    syncEditQuantities();
    editState.editIndex = Number(btn.dataset.editChange);
    editState.mode = 'pick-material';
    renderEditForm();
  }));
  orderFormEl.querySelectorAll('[data-edit-remove]').forEach(btn => btn.addEventListener('click', () => {
    syncEditQuantities();
    editState.items.splice(Number(btn.dataset.editRemove), 1);
    renderEditForm();
  }));
  document.getElementById('edit-add-item-btn').addEventListener('click', () => {
    syncEditQuantities();
    editState.editIndex = 'new';
    editState.mode = 'pick-material';
    renderEditForm();
  });
  document.getElementById('edit-change-source-btn').addEventListener('click', () => {
    syncEditQuantities();
    editState.mode = 'pick-source';
    renderEditForm();
  });
  document.getElementById('edit-change-site-btn').addEventListener('click', () => {
    syncEditQuantities();
    editState.mode = 'pick-site';
    renderEditForm();
  });
  document.getElementById('edit-save-btn').addEventListener('click', submitEdit);
}

function renderEditPickMaterial() {
  orderFormEl.innerHTML = `
    <h2>Change material</h2>
    <p class="hint">Start typing to find a different material — you'll also need to pick a size and stockist for it.</p>
    <input type="text" id="edit-material-search-input" class="search-input" placeholder="Search for materials, tools, PPE…" autocomplete="off" />
    <div id="edit-material-results" class="results-list"></div>
    <button type="button" class="link-btn" id="edit-material-cancel-btn">Cancel</button>
  `;

  const input = document.getElementById('edit-material-search-input');
  const results = document.getElementById('edit-material-results');
  input.addEventListener('input', () => {
    if (!input.value.trim()) {
      results.innerHTML = '';
      return;
    }
    const products = searchProducts(input.value);
    results.innerHTML = products.map(p => `
      <button class="result-card" data-id="${p.id}">
        <span class="result-name">${p.name}</span>
        <span class="result-meta">${p.category} &middot; ${formatPrice(p.unitPrice)} per ${p.unit}</span>
      </button>
    `).join('');
    results.querySelectorAll('.result-card').forEach(btn => {
      btn.addEventListener('click', () => {
        const product = products.find(pr => pr.id === btn.dataset.id);
        editState.pickProduct = product;
        editState.pickVariant = null;
        editState.mode = product.variants ? 'pick-variant' : 'pick-item-qty';
        renderEditForm();
      });
    });
  });
  document.getElementById('edit-material-cancel-btn').addEventListener('click', () => {
    editState.mode = 'summary';
    renderEditForm();
  });
}

function renderEditPickVariant() {
  const product = editState.pickProduct;
  orderFormEl.innerHTML = `
    <h2>${product.name}</h2>
    <label class="field-label">Which size / type do you need?</label>
    <div class="variant-list">
      ${product.variants.map(v => `
        <button type="button" class="variant-option" data-variant="${v}">
          <span class="variant-option-radio" aria-hidden="true"></span>
          <span class="variant-option-label">${v}</span>
          <span class="variant-option-arrow" aria-hidden="true">&rarr;</span>
        </button>
      `).join('')}
      <button type="button" class="variant-option variant-option-custom" id="edit-custom-size-toggle">
        <span class="variant-option-radio" aria-hidden="true">+</span>
        <span class="variant-option-label">None of these — enter a custom size</span>
        <span class="variant-option-arrow" aria-hidden="true">&rarr;</span>
      </button>
    </div>
    <div class="custom-size-form" id="edit-custom-size-form" hidden>
      <label class="field-label" for="edit-custom-size-input">Custom size / measurement</label>
      <input type="text" id="edit-custom-size-input" class="text-input" placeholder="e.g. 2700 x 1200 x 15mm" />
      <button type="button" id="edit-custom-size-continue" class="btn btn-primary btn-block">Continue</button>
    </div>
    <button type="button" class="link-btn" id="edit-variant-cancel-btn">Cancel</button>
  `;

  orderFormEl.querySelectorAll('.variant-option:not(.variant-option-custom)').forEach(btn => {
    btn.addEventListener('click', () => {
      editState.pickVariant = btn.dataset.variant;
      editState.mode = 'pick-item-qty';
      renderEditForm();
    });
  });
  document.getElementById('edit-custom-size-toggle').addEventListener('click', () => {
    document.getElementById('edit-custom-size-toggle').hidden = true;
    document.getElementById('edit-custom-size-form').hidden = false;
  });
  document.getElementById('edit-custom-size-continue').addEventListener('click', () => {
    const val = document.getElementById('edit-custom-size-input').value.trim();
    if (!val) return;
    editState.pickVariant = val;
    editState.mode = 'pick-item-qty';
    renderEditForm();
  });
  document.getElementById('edit-variant-cancel-btn').addEventListener('click', () => {
    editState.mode = 'summary';
    renderEditForm();
  });
}

function renderEditPickSource() {
  const product = getProduct(editState.items[0] ? editState.items[0].productId : null);
  if (!product) { editState.mode = 'summary'; renderEditForm(); return; }
  const sources = getBranchesForProduct(product);
  orderFormEl.innerHTML = `
    <h2>Where should this be ordered from?</h2>
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
    <button type="button" class="link-btn" id="edit-source-cancel-btn">Cancel</button>
  `;

  orderFormEl.querySelectorAll('.source-option').forEach(btn => {
    btn.addEventListener('click', () => {
      const branch = sources.find(s => s.id === btn.dataset.branchId);
      const avail = getAvailability(branch.id, product.id);
      editState.stockistId = branch.id;
      editState.stockistName = branch.name;
      editState.stockistWebsite = branch.website;
      editState.stockistPostcode = branch.postcode;
      editState.pickupEstimate = avail ? avail.label : null;
      editState.mode = 'summary';
      renderEditForm();
    });
  });
  document.getElementById('edit-source-cancel-btn').addEventListener('click', () => {
    editState.mode = 'summary';
    renderEditForm();
  });
}

// The exact same authorized-sites source the initial site picker uses
// (getActiveSitesForUser) — never a free-text field, so a target site the
// Worker isn't assigned to can't even be offered here, on top of
// editOrder()'s own independent canCreateOrderForSite re-check.
function renderEditPickSite() {
  const communityId = getActiveCommunityId();
  const userId = getCurrentUserId();
  const sites = getActiveSitesForUser(communityId, userId);
  orderFormEl.innerHTML = `
    <h2>Change site</h2>
    <div class="community-list" id="edit-site-list">
      ${sites.map(s => `
        <button type="button" class="result-card" data-site-id="${s.id}">
          <span class="result-name">${s.name}</span>
          <span class="result-meta">${[s.address, s.postcode].filter(Boolean).join(' · ') || 'No address on file'}</span>
        </button>
      `).join('') || '<p class="empty-hint">You are not assigned to any active site.</p>'}
    </div>
    <button type="button" class="link-btn" id="edit-site-cancel-btn">Cancel</button>
  `;
  document.getElementById('edit-site-list').querySelectorAll('[data-site-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      const site = sites.find(s => s.id === btn.dataset.siteId);
      editState.site = site;
      editState.deliveryPostcode = site.postcode || editState.deliveryPostcode;
      editState.mode = 'summary';
      renderEditForm();
    });
  });
  document.getElementById('edit-site-cancel-btn').addEventListener('click', () => {
    editState.mode = 'summary';
    renderEditForm();
  });
}

async function submitEdit() {
  const s = editState;
  const statusEl = document.getElementById('edit-form-status');
  const saveBtn = document.getElementById('edit-save-btn');
  syncEditQuantities();
  const postcodeRaw = document.getElementById('edit-postcode-input').value.trim();

  if (s.items.length === 0) {
    statusEl.textContent = 'An order needs at least one material.';
    statusEl.className = 'form-status error';
    return;
  }
  if (!postcodeRaw) {
    statusEl.textContent = 'Please enter a delivery postcode.';
    statusEl.className = 'form-status error';
    return;
  }
  const deliveryPostcode = postcodeRaw.toUpperCase();

  // Unlike creation, an edit must NOT force a fresh Needed-by choice on
  // every save — a historical order's untouched null/null (or an
  // unmodified ASAP/existing deadline) is completely legal to save
  // straight through, since edit_order's own "only re-validate what's
  // actually changing" rule already handles that correctly server-side.
  // The only client-side guard needed here is against a genuinely
  // inconsistent state (a 'deadline' selection with no timestamp) — which
  // wireNeededByControl's own custom-input handling already prevents in
  // practice, but this stays as defense-in-depth against the CHECK
  // constraint's 23514 rather than a friendly message.
  if (s.neededByType === 'deadline' && s.neededBy == null) {
    const errorEl = document.getElementById('needed-by-error');
    if (errorEl) errorEl.hidden = false;
    return;
  }

  const fields = {
    items: s.items.map(it => ({ ...it })),
    deliveryPostcode,
    siteId: s.site.id,
    stockistId: s.stockistId,
    stockistName: s.stockistName,
    stockistWebsite: s.stockistWebsite,
    stockistPostcode: s.stockistPostcode,
    pickupEstimate: s.pickupEstimate,
    neededByType: s.neededByType,
    neededBy: s.neededBy,
  };

  if (deliveryPostcode !== s.order.deliveryPostcode) {
    statusEl.textContent = 'Looking up delivery postcode…';
    statusEl.className = 'form-status';
    const location = await geocodePostcode(deliveryPostcode);
    if (!location) {
      statusEl.textContent = `Couldn't verify "${deliveryPostcode}" — check it and try again.`;
      statusEl.className = 'form-status error';
      return;
    }
    fields.deliveryLat = location.lat;
    fields.deliveryLon = location.lon;
  }

  const willReapprove = !!s.order.approvedById;
  saveBtn.disabled = true;
  const result = await editOrder(s.order.id, fields);
  if (!result.ok) {
    saveBtn.disabled = false;
    statusEl.textContent = result.error;
    statusEl.className = 'form-status error';
    return;
  }

  orderFormEl.innerHTML = `
    <h2>Order updated</h2>
    <p class="hint">${willReapprove
      ? 'Your changes were saved. This order needs the owner to approve it again before a buyer can purchase it.'
      : 'Your changes were saved.'}</p>
  `;
  setTimeout(closeEditForm, 1400);
}

function renderSiteOrders() {
  const communityId = getActiveCommunityId();
  const sorted = latestOrders
    .filter(o => o.communityId === communityId)
    .sort((a, b) => b.createdAt - a.createdAt);
  if (sorted.length === 0) {
    siteOrdersList.innerHTML = '<p class="empty-hint">No orders placed yet.</p>';
    return;
  }
  siteOrdersList.innerHTML = sorted.map(o => {
    const isOwn = o.requestedById === getCurrentUserId();
    const urgency = neededByUrgency(o.neededByType, o.neededBy, o.status);
    const urgencyWord = urgencyLabel(urgency);
    const pendingCancellation = !!getPendingCancellationRequestForOrder(o.id);
    const nextAction = nextActionFor(o, 'worker', { pendingCancellationRequest: pendingCancellation });

    return `
    <div class="order-card status-${o.status}" data-order-id="${o.id}">
      <div class="order-card-main">
        <strong>${itemsShortSummary(o)}</strong>
        <span>${o.siteName ? `${escapeHtml(o.siteName)} &middot; ` : ""}${(o.items || []).map(it => `${escapeHtml(it.quantity)}×${escapeHtml(it.productName)}`).join(', ')} &middot; to ${escapeHtml(o.deliveryPostcode)}${o.totalPrice != null ? ` &middot; ${formatPrice(o.totalPrice)}` : ''}</span>
        ${o.stockistName ? `<span>From ${escapeHtml(o.stockistName)} (${escapeHtml(o.stockistWebsite)})</span>` : ''}
        <span class="order-needed-by${urgency !== 'none' && urgency !== 'future' ? ` urgency-${urgency}` : ''}">Needed by: ${formatNeededBy(o.neededByType, o.neededBy)}${urgencyWord ? ` &middot; ${urgencyWord}` : ''}</span>
        ${o.status === 'rejected' && o.rejectionReason ? `<span class="rejection-reason">Reason: ${escapeHtml(o.rejectionReason)}</span>` : ''}
        ${o.status === 'cancelled' ? `<span class="rejection-reason">Cancelled by ${escapeHtml(o.orderCancelledBy || "you")}${o.orderCancellationReason ? `: ${escapeHtml(o.orderCancellationReason)}` : ""}</span>` : ''}
        ${o.status === 'delivered' && o.deliveryLocation ? `<span>Delivered to ${escapeHtml(o.deliveryLocation)} at ${new Date(o.deliveryTime).toLocaleString()}</span>` : ''}
        ${fulfilmentSummary(o) ? `<span class="rejection-reason">${fulfilmentSummary(o)}</span>` : ''}
      </div>
      <span class="status-badge status-${o.status}">${statusLabel(o.status, 'worker', o.deliveryMethod)}</span>
      ${o.fulfilmentStatus === 'partial' ? '<span class="status-badge status-rejected">Partial</span>' : ''}
      ${nextAction ? `<span class="order-next-action">${nextAction}</span>` : ''}
      ${cancellationStateHint(o)}
      ${isOwn ? `<div class="order-card-links">${renderHistoryToggle(o)}<button type="button" class="link-btn" data-open-messages="${o.id}">Messages${getMessageCountForOrder(o.id) ? ` (${getMessageCountForOrder(o.id)})` : ''}</button></div>` : ''}
      ${isOwn && expandedHistoryIds.has(o.id) ? renderOrderHistory(o) : ''}
      ${renderWorkerActions(o)}
    </div>
  `;
  }).join('');

  siteOrdersList.querySelectorAll('[data-worker-action]').forEach(btn => {
    btn.addEventListener('click', () => handleWorkerAction(btn.dataset.workerAction, btn.dataset.id));
  });

  siteOrdersList.querySelectorAll('[data-history-toggle]').forEach(btn => {
    btn.addEventListener('click', () => toggleHistory(btn.dataset.historyToggle));
  });

  siteOrdersList.querySelectorAll('[data-open-messages]').forEach(btn => {
    btn.addEventListener('click', () => openMessagesPanel(btn.dataset.openMessages));
  });

  if (cancellingOrderId) wireCancelHoldButton(cancellingOrderId);

  const reasonInput = siteOrdersList.querySelector('#request-cancel-reason-input');
  if (reasonInput) reasonInput.focus();
}

// --- Roadmap Step 4: Worker's own-order inline history ------------------
// Reuses orderStatus.js's describeEvent (the exact same icon/text map
// owner.js's dashboard activity feed and order-detail timeline already use)
// and the existing .activity-list/.activity-item CSS — no new timeline
// rendering system, no new event data, no new panel/route.

function renderHistoryToggle(order) {
  const expanded = expandedHistoryIds.has(order.id);
  return `<button type="button" class="link-btn order-history-toggle" data-history-toggle="${order.id}">${expanded ? 'Hide history' : 'Show history'}</button>`;
}

function renderOrderHistory(order) {
  const label = `${order.productName}${order.variant ? ` (${order.variant})` : ''}`;
  const events = getOrderEvents(order.id);
  if (events.length === 0) return '<div class="order-history"><p class="empty-hint">No events recorded.</p></div>';
  return `
    <div class="order-history activity-list">
      ${events.map(e => {
        const { icon, text } = describeEvent(e, label);
        return `
          <div class="activity-item">
            <span class="activity-icon" aria-hidden="true">${icon}</span>
            <span class="activity-text">${text}</span>
            <span class="activity-time">${new Date(e.createdAt).toLocaleString()}</span>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function toggleHistory(orderId) {
  if (expandedHistoryIds.has(orderId)) expandedHistoryIds.delete(orderId);
  else expandedHistoryIds.add(orderId);
  renderSiteOrders();
}

export function refreshWorkerView() {
  closeOrderForm();
  editState = null;
  messagesOrderId = null;
  cancellingOrderId = null;
  requestingCancelOrderId = null;
  expandedHistoryIds = new Set();
  showSiteSelect();
  renderSiteOrders();
}

subscribe(orders => {
  latestOrders = orders;
  renderSiteOrders();
});

subscribeCancellationRequests(renderSiteOrders);
subscribeOrderMessages(() => {
  if (messagesOrderId && !orderPanel.hidden) {
    const el = document.getElementById('worker-order-thread');
    if (el) renderOrderThread(el, messagesOrderId);
  } else {
    renderSiteOrders(); // keep the "Messages (N)" counts fresh
  }
});

// Roadmap Step 4 — keeps an expanded history panel live: order_events isn't
// itself in the Realtime publication, but refreshOrderCache() always
// refetches orders/order_events/cancellation_requests together (see
// orderLifecycle.js), so any orders-table change (which every event-producing
// RPC also makes, in the same transaction) already re-populates the event
// cache too — this just re-renders off it, no new subscription needed.
subscribeOrderEvents(renderSiteOrders);

// Phase 8D.2 — live site-picker freshness, PLUS (Test 4 fix) live
// active-site invalidation. The original version of this handler only
// re-rendered the picker's own LIST, and only while the Worker was actually
// sitting on the picker screen (siteSelectPanel visible) — that's the case
// the local multi-tab verification covered, and it worked. A real
// second-physical-device test found the actual gap: a Worker who had
// already CHOSEN a site (`selectedSite` set, now on the search/order-form
// screens with the picker hidden) kept using that site with no visible
// change after their membership was removed mid-session — nothing here was
// even looking at `selectedSite` at all, so a Realtime-triggered cache
// refresh had nothing to react to for that case. Fixed by additionally
// checking, on every refreshed (authoritative, never the raw Realtime
// payload) sites cache, whether the Worker's current `selectedSite` is
// still in their real authorized list — if not, `refreshWorkerView()` (the
// same full reset `main.js` already uses on ordinary view-entry) closes
// whatever order/edit context was open and returns them to a freshly
// re-derived site-selection screen, which itself shows the existing
// "you haven't been assigned to a site yet" message if none remain. This
// was always a UI-freshness gap, never a security one — createOrder's/
// editOrder's own canCreateOrderForSite re-check already refuses
// server-side regardless of what this UI happens to be showing.
subscribeSites(() => {
  if (!siteSelectPanel.hidden) {
    renderSiteSelectList();
    return;
  }
  if (!selectedSite) return;
  const communityId = getActiveCommunityId();
  const userId = getCurrentUserId();
  const stillAuthorized = getActiveSitesForUser(communityId, userId).some(s => s.id === selectedSite.id);
  if (!stillAuthorized) refreshWorkerView();
});
