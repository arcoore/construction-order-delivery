import { getInitials, escapeHtml } from './data.js';
import { getProduct } from './products.js';
import { getBranch } from './suppliers.js';
import { distanceKm, getCurrentPosition, geocodePostcode } from './geo.js';
import { getActiveCommunityId } from './community.js';
import { getCurrentUserId } from './identity.js';
import { subscribe, claimDelivery, collectDelivery, deliverOrder, cancelDelivery } from './orderLifecycle.js';
import { formatNeededBy, neededByUrgency, urgencyLabel } from './deadline.js';
import { statusLabel, nextActionFor, urgencyComparator, itemsSummary, itemsShortSummary, fulfilmentSummary } from './orderStatus.js';
import { renderOrderThread } from './orderThreadView.js';
import { subscribeOrderMessages, getMessageCountForOrder } from './orderMessages.js';
import { renderDeliveryPhotos } from './deliveryPhotosView.js';
import { subscribeDeliveryPhotos, getPhotoCountForOrder } from './deliveryPhotos.js';

const locateBtn = document.getElementById('locate-btn');
const locationStatus = document.getElementById('location-status');
const tabsEl = document.getElementById('driver-tabs');
const listEl = document.getElementById('driver-orders-list');

let driverPos = null;
let activeTab = 'available';
let latestOrders = [];
let cancellingId = null;
let deliveringId = null;
let completedShowAll = false;
const COMPLETED_PAGE = 25;
let threadOrderId = null;
let threadDraft = '';

// YYYY-MM-DDTHH:mm in local time, for a datetime-local input's default value.
function nowForDateTimeInput() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

locateBtn.addEventListener('click', async () => {
  locationStatus.textContent = 'Getting location…';
  locationStatus.className = 'location-status';
  try {
    driverPos = await getCurrentPosition();
    locationStatus.textContent = `Location set (±GPS) - ${driverPos.lat.toFixed(3)}, ${driverPos.lon.toFixed(3)}`;
    locationStatus.className = 'location-status ok';
  } catch {
    locationStatus.textContent = 'Location unavailable - enter your postcode instead:';
    locationStatus.className = 'location-status error';
    promptManualPostcode();
    return;
  }
  render();
});

function promptManualPostcode() {
  const wrap = document.createElement('div');
  wrap.className = 'manual-postcode';
  wrap.innerHTML = `
    <input type="text" id="manual-postcode-input" class="text-input" placeholder="Your current postcode" />
    <button id="manual-postcode-btn" class="btn btn-secondary">Set</button>
  `;
  locationStatus.after(wrap);
  document.getElementById('manual-postcode-btn').addEventListener('click', async () => {
    const val = document.getElementById('manual-postcode-input').value.trim();
    if (!val) return;
    const loc = await geocodePostcode(val);
    if (!loc) {
      locationStatus.textContent = `Couldn't find postcode "${val}".`;
      locationStatus.className = 'location-status error';
      return;
    }
    driverPos = loc;
    locationStatus.textContent = `Location set from postcode ${val.toUpperCase()}`;
    locationStatus.className = 'location-status ok';
    wrap.remove();
    render();
  });
}

tabsEl.addEventListener('click', e => {
  const btn = e.target.closest('.tab-btn');
  if (!btn) return;
  activeTab = btn.dataset.tab;
  cancellingId = null;
  deliveringId = null;
  completedShowAll = false;
  tabsEl.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
  render();
});

// Phase B hardening - real numeric coordinates only. A resolved branch can
// still have null lat/lon (never required by Phase A/B), and since 0018 a
// branch can legitimately fail to resolve at all (getBranch returns null - 
// its supplier or the branch itself went inactive after an in-flight
// order's stockistId was snapshotted). Never coerce a missing coordinate
// into 0,0 (JS's `null - lat` silently does exactly that) - return null,
// never Infinity/NaN, whenever either point isn't a real coordinate.
function safeDistanceKm(a, b) {
  if (!a || !b || !Number.isFinite(a.lat) || !Number.isFinite(a.lon) || !Number.isFinite(b.lat) || !Number.isFinite(b.lon)) {
    return null;
  }
  return distanceKm(a, b);
}

// Defensive fallback only - every order should already carry the stockistId
// the worker chose at creation. Kept in case that's ever missing.
function nearestBranchFor(order, from) {
  const product = getProduct(order.items && order.items[0] ? order.items[0].productId : null);
  if (!product) return null;
  let best = null;
  let bestDist = Infinity;
  for (const bid of product.branchIds) {
    const branch = getBranch(bid);
    if (!branch) continue;
    const d = from ? safeDistanceKm(from, branch) : null;
    if (from) {
      if (d != null && d < bestDist) {
        bestDist = d;
        best = branch;
      }
    } else if (!best) {
      best = branch;
    }
  }
  return best ? { branch: best, distanceKm: from ? bestDist : null } : null;
}

// Phase B hardening - order.stockistId can now legitimately fail to
// resolve (see safeDistanceKm's comment above); this never crashes and
// never invents a distance. Calls getBranch exactly once (the old code
// called it twice per order, redundantly).
function resolvePickup(order, from) {
  if (order.stockistId) {
    const branch = getBranch(order.stockistId);
    return {
      branch,
      distanceKm: (branch && from) ? safeDistanceKm(from, branch) : null,
    };
  }
  return nearestBranchFor(order, from);
}

function currentDriverId() {
  return getCurrentUserId();
}

function render() {
  // Capture an in-progress message draft before the list DOM is rebuilt.
  const openInput = listEl.querySelector('.msg-input');
  if (openInput) threadDraft = openInput.value;

  const communityId = getActiveCommunityId();
  const orders = latestOrders.filter(o => o.communityId === communityId);
  let filtered;
  let completedRemaining = 0;
  if (activeTab === 'available') {
    // direct_supplier orders never enter the driver pool at all - the
    // merchant delivers straight to site, so there is no leg for a driver
    // to claim (confirm_direct_delivery is the buyer's own action instead;
    // claim_delivery itself also refuses this server-side, this is just the
    // matching UI-level filter so one is never even shown as claimable).
    filtered = orders.filter(o => o.status === 'purchased' && o.deliveryMethod !== 'direct_supplier');
  } else if (activeTab === 'mine') {
    filtered = orders.filter(o => o.driverId === currentDriverId() && ['claimed', 'collected'].includes(o.status));
  } else {
    // Completed: most recently delivered first, capped so a long-serving
    // driver's history stays a glance, not an endless scroll.
    const done = orders
      .filter(o => o.status === 'delivered' && o.driverId === currentDriverId())
      .sort((a, b) => (b.deliveredAt || 0) - (a.deliveredAt || 0));
    filtered = completedShowAll ? done : done.slice(0, COMPLETED_PAGE);
    completedRemaining = done.length - filtered.length;
  }

  if (filtered.length === 0) {
    listEl.innerHTML = `<p class="empty-hint">Nothing here right now.</p>`;
    return;
  }

  const withDistance = filtered.map(o => ({ order: o, pickup: resolvePickup(o, driverPos) }));

  // Roadmap Step 4, Section 11 override - distance stays the PRIMARY sort
  // whenever a real pickup distance is available (the one trusted, honest
  // ranking signal this app has always had here); urgency is only ever a
  // secondary tie-break in that case, so a distant ASAP order never jumps
  // ahead of a genuinely nearby one. Only when there's no driver location
  // at all (nothing to rank distance by) does urgency become the primary
  // signal, with request age as the final tie-break either way.
  if (activeTab === 'available') {
    if (driverPos) {
      withDistance.sort((a, b) => {
        const distA = a.pickup?.distanceKm ?? Infinity;
        const distB = b.pickup?.distanceKm ?? Infinity;
        if (distA !== distB) return distA - distB;
        const urgencyDiff = urgencyComparator(a.order, b.order);
        if (urgencyDiff !== 0) return urgencyDiff;
        return a.order.createdAt - b.order.createdAt;
      });
    } else {
      withDistance.sort((a, b) => {
        const urgencyDiff = urgencyComparator(a.order, b.order);
        if (urgencyDiff !== 0) return urgencyDiff;
        return a.order.createdAt - b.order.createdAt;
      });
    }
  }

  const locationHint = activeTab === 'available' && !driverPos
    ? '<p class="empty-hint">Set your current location above to sort these by distance.</p>'
    : '';

  const showMoreHtml = completedRemaining > 0
    ? `<button type="button" class="link-btn list-show-more" id="completed-show-more">Show ${completedRemaining} older</button>`
    : '';
  listEl.innerHTML = locationHint + withDistance.map(({ order, pickup }) => renderOrderCard(order, pickup)).join('') + showMoreHtml;

  const completedShowMore = document.getElementById('completed-show-more');
  if (completedShowMore) completedShowMore.addEventListener('click', () => { completedShowAll = true; render(); });

  listEl.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', () => handleAction(btn.dataset.action, btn.dataset.id));
  });

  const reasonInput = listEl.querySelector('#cancel-reason-input');
  if (reasonInput) reasonInput.focus();
  const deliveryLocationInput = listEl.querySelector('#delivery-location-input');
  if (deliveryLocationInput) deliveryLocationInput.focus();

  // Partial fulfilment - a ticked "short" checkbox reveals its note field.
  listEl.querySelectorAll('.shortfall-check').forEach(cb => {
    cb.addEventListener('change', () => {
      const note = listEl.querySelector(`.shortfall-note[data-note-for="${cb.dataset.itemId}"]`);
      if (note) note.hidden = !cb.checked;
    });
  });

  listEl.querySelectorAll('[data-toggle-thread]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.toggleThread;
      threadOrderId = threadOrderId === id ? null : id;
      render();
    });
  });
  if (threadOrderId) {
    const el = listEl.querySelector(`[data-thread-container="${threadOrderId}"]`);
    if (el) renderOrderThread(el, threadOrderId, threadDraft);
  }
  threadDraft = '';

  listEl.querySelectorAll('[data-photos-for]').forEach(el => {
    const oid = el.dataset.photosFor;
    const order = latestOrders.find(o => o.id === oid);
    renderDeliveryPhotos(el, oid, {
      canUpload: order && order.driverId === currentDriverId() && ['collected', 'delivered'].includes(order.status),
    });
  });
}

// A plain Google Maps "search" link - opens in the browser or hands off to
// the Maps app on a phone. No API key, no embed, no tracking beyond the
// query itself. Only rendered when there's a real postcode/address to point
// at, never a broken link.
function mapsLink(query, label) {
  const q = (query || '').trim();
  if (!q) return '';
  return `<a class="route-maps-link" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}" target="_blank" rel="noopener noreferrer">${label} &nearr;</a>`;
}

function renderOrderCard(order, pickup) {
  const branch = pickup?.branch;
  const dist = pickup?.distanceKm;
  const deliveryDist = branch
    ? safeDistanceKm(branch, { lat: order.deliveryLat, lon: order.deliveryLon })
    : null;
  // Phase B hardening - when the live branch can't be resolved (deactivated
  // since this order's stockistId was snapshotted), fall back to the
  // order's own point-in-time snapshot fields rather than showing nothing - 
  // historical/in-flight order display must never depend on a live supplier
  // row. Pickup distance has no snapshot substitute, so it's simply omitted
  // (Number.isFinite below), matching how this card already silently omits
  // it when the Driver hasn't set a location - never "Infinity"/"NaN".
  const buyFromName = branch ? branch.name : (order.stockistName || 'Unknown');
  // Plain text (escaped by the caller before it hits innerHTML) - a real
  // middle-dot, not a &middot; entity, so escaping doesn't mangle it.
  const buyFromSub = branch
    ? `${branch.website} · ${branch.postcode}`
    : [order.stockistWebsite, order.stockistPostcode].filter(Boolean).join(' · ');

  let actionHtml = '';
  if (order.status === 'purchased') {
    actionHtml = `<button class="btn btn-primary" data-action="claim" data-id="${order.id}">Claim this delivery</button>`;
  } else if (order.status === 'claimed') {
    if (cancellingId === order.id) {
      actionHtml = `
        <div class="reject-form">
          <label class="field-label" for="cancel-reason-input">Reason for cancelling (required)</label>
          <input type="text" id="cancel-reason-input" class="text-input" placeholder="e.g. Vehicle broke down" />
          <div class="reject-form-actions">
            <button class="btn btn-secondary" data-action="cancel-cancel" data-id="${order.id}">Never mind</button>
            <button class="btn btn-primary" data-action="confirm-cancel" data-id="${order.id}">Confirm cancellation</button>
          </div>
        </div>
      `;
    } else {
      actionHtml = `
        <div class="owner-actions">
          <button class="btn btn-secondary" data-action="cancel" data-id="${order.id}">Cancel delivery</button>
          <button class="btn btn-primary" data-action="collect" data-id="${order.id}">Mark collected</button>
        </div>
      `;
    }
  } else if (order.status === 'collected') {
    if (deliveringId === order.id) {
      actionHtml = `
        <div class="reject-form">
          <label class="field-label" for="delivery-time-input">Delivered at</label>
          <input type="datetime-local" id="delivery-time-input" class="text-input" value="${nowForDateTimeInput()}" />
          <label class="field-label" for="delivery-location-input">Delivered to (location)</label>
          <input type="text" id="delivery-location-input" class="text-input" placeholder="e.g. Site gate, SW1A 1AA" value="${order.deliveryPostcode || ''}" />
          ${(order.items && order.items.length) ? `
          <p class="field-label">Anything short or missing? (optional)</p>
          <div class="delivery-shortfalls">
            ${order.items.map(it => `
              <label class="shortfall-row">
                <input type="checkbox" class="shortfall-check" data-item-id="${it.id}" />
                <span>${it.quantity} × ${it.productName}${it.variant ? ` (${it.variant})` : ''}</span>
              </label>
              <input type="text" class="text-input shortfall-note" data-note-for="${it.id}" placeholder="What was short? (optional)" hidden />
            `).join('')}
          </div>` : ''}
          <div class="reject-form-actions">
            <button class="btn btn-secondary" data-action="cancel-deliver" data-id="${order.id}">Never mind</button>
            <button class="btn btn-primary" data-action="confirm-deliver" data-id="${order.id}">Confirm Delivered</button>
          </div>
        </div>
      `;
    } else {
      actionHtml = `<button class="btn btn-primary" data-action="deliver" data-id="${order.id}">Deliver</button>`;
    }
  }

  const requesterNameRaw = order.requestedBy || 'Unknown';
  const requesterName = escapeHtml(requesterNameRaw);
  const urgency = neededByUrgency(order.neededByType, order.neededBy, order.status);
  const urgencyWord = urgencyLabel(urgency);
  const nextAction = nextActionFor(order, 'driver');

  return `
    <div class="order-card driver-card status-${order.status}" data-order-id="${order.id}">
      <div class="request-header">
        <div class="requester-badge" title="Requested by ${requesterName}">
          <span class="requester-avatar">${getInitials(requesterNameRaw)}</span>
          <span class="requester-name">${requesterName}</span>
        </div>
        <div class="order-card-main">
          <strong>${itemsShortSummary(order)}</strong>
          <span>${itemsSummary(order)}</span>
          <span class="order-needed-by${urgency !== 'none' && urgency !== 'future' ? ` urgency-${urgency}` : ''}">Needed by: ${formatNeededBy(order.neededByType, order.neededBy)}${urgencyWord ? ` &middot; ${urgencyWord}` : ''}</span>
        </div>
      </div>
      <div class="driver-route">
        <div class="route-step">
          <span class="route-label">Buy from</span>
          <span class="route-value">${escapeHtml(buyFromName)}</span>
          ${buyFromSub ? `<span class="route-sub">${escapeHtml(buyFromSub)}</span>` : ''}
          ${order.pickupEstimate ? `<span class="route-sub route-pickup-estimate">${escapeHtml(order.pickupEstimate)}</span>` : ''}
          ${Number.isFinite(dist) ? `<span class="route-dist">${dist.toFixed(1)} km from you</span>` : ''}
          ${mapsLink(branch ? branch.postcode : order.stockistPostcode, 'Open pickup in Maps')}
        </div>
        <div class="route-arrow">to</div>
        <div class="route-step">
          <span class="route-label">Deliver to</span>
          <span class="route-value">${escapeHtml(order.siteName || order.deliveryPostcode)}</span>
          ${order.siteName ? `<span class="route-sub">${escapeHtml([order.siteAddress, order.sitePostcode].filter(Boolean).join(' · ') || order.deliveryPostcode)}</span>` : ''}
          ${order.siteDeliveryInstructions ? `<span class="route-sub"><b>Instructions:</b> ${escapeHtml(order.siteDeliveryInstructions)}</span>` : ''}
          ${order.siteAccessNotes ? `<span class="route-sub"><b>Access:</b> ${escapeHtml(order.siteAccessNotes)}</span>` : ''}
          ${order.siteContactName || order.siteContactPhone ? `<span class="route-sub"><b>Contact:</b> ${escapeHtml(order.siteContactName || '')}${order.siteContactName && order.siteContactPhone ? ' · ' : ''}${order.siteContactPhone ? `<a href="tel:${escapeHtml(order.siteContactPhone.replace(/[^\d+]/g, ''))}">${escapeHtml(order.siteContactPhone)}</a>` : ''}</span>` : ''}
          ${Number.isFinite(deliveryDist) ? `<span class="route-dist">${deliveryDist.toFixed(1)} km from pickup</span>` : ''}
          ${mapsLink([order.siteAddress, order.sitePostcode].filter(Boolean).join(', ') || order.deliveryPostcode, 'Open delivery in Maps')}
        </div>
      </div>
      <span class="status-badge status-${order.status}">${statusLabel(order.status, 'driver', order.deliveryMethod)}</span>
      ${nextAction ? `<span class="order-next-action">${nextAction}</span>` : ''}
      ${order.status === 'delivered' && order.deliveryLocation
        ? `<p class="hint small-hint">Delivered to ${escapeHtml(order.deliveryLocation)} at ${new Date(order.deliveryTime).toLocaleString()}</p>` : ''}
      ${fulfilmentSummary(order) ? `<p class="hint small-hint">${fulfilmentSummary(order)}</p>` : ''}
      ${actionHtml}
      ${['collected', 'delivered'].includes(order.status) || getPhotoCountForOrder(order.id)
        ? `<div class="delivery-photos-wrap" data-photos-for="${order.id}"></div>` : ''}
      <button type="button" class="link-btn" data-toggle-thread="${order.id}">
        ${threadOrderId === order.id ? 'Hide messages' : `Messages${getMessageCountForOrder(order.id) ? ` (${getMessageCountForOrder(order.id)})` : ''}`}
      </button>
      ${threadOrderId === order.id ? `<div class="driver-thread" data-thread-container="${order.id}"></div>` : ''}
    </div>
  `;
}

let actionInFlight = false;

async function handleAction(action, orderId) {
  if (action === 'deliver') {
    deliveringId = orderId;
    render();
    return;
  }
  if (action === 'cancel-deliver') {
    deliveringId = null;
    render();
    return;
  }
  if (action === 'cancel') {
    cancellingId = orderId;
    render();
    return;
  }
  if (action === 'cancel-cancel') {
    cancellingId = null;
    render();
    return;
  }

  if (actionInFlight) return;

  let result;
  if (action === 'claim') {
    actionInFlight = true;
    result = await claimDelivery(orderId);
  } else if (action === 'collect') {
    actionInFlight = true;
    result = await collectDelivery(orderId);
  } else if (action === 'confirm-deliver') {
    const timeInput = document.getElementById('delivery-time-input');
    const locationInput = document.getElementById('delivery-location-input');
    const timeVal = timeInput ? timeInput.value : '';
    const locationVal = locationInput ? locationInput.value.trim() : '';
    if (!timeVal) {
      timeInput.focus();
      return;
    }
    if (!locationVal) {
      locationInput.focus();
      return;
    }
    const shortfalls = [...document.querySelectorAll('.shortfall-check')]
      .filter(cb => cb.checked)
      .map(cb => ({
        itemId: cb.dataset.itemId,
        note: (document.querySelector(`.shortfall-note[data-note-for="${cb.dataset.itemId}"]`)?.value || '').trim(),
      }));
    actionInFlight = true;
    result = await deliverOrder(orderId, new Date(timeVal).getTime(), locationVal, shortfalls);
    deliveringId = null;
  } else if (action === 'confirm-cancel') {
    const reasonInput = document.getElementById('cancel-reason-input');
    const reason = reasonInput ? reasonInput.value.trim() : '';
    if (!reason) {
      reasonInput.focus();
      return;
    }
    actionInFlight = true;
    result = await cancelDelivery(orderId, reason);
    cancellingId = null;
  }
  actionInFlight = false;

  if (result && !result.ok) {
    alert(result.error);
  }
}

export function refreshDriverView() {
  activeTab = 'available';
  cancellingId = null;
  deliveringId = null;
  completedShowAll = false;
  threadOrderId = null;
  tabsEl.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === 'available'));
  render();
}

subscribe(orders => {
  latestOrders = orders;
  render();
});

subscribeOrderMessages(render);
subscribeDeliveryPhotos(render);
