import { getProduct, getInitials } from './data.js';
import { getBranch } from './suppliers.js';
import { distanceKm, getCurrentPosition, geocodePostcode } from './geo.js';
import { getActiveCommunityId } from './community.js';
import { getCurrentUserId } from './identity.js';
import { subscribe, claimDelivery, collectDelivery, deliverOrder, cancelDelivery } from './orderLifecycle.js';

const locateBtn = document.getElementById('locate-btn');
const locationStatus = document.getElementById('location-status');
const tabsEl = document.getElementById('driver-tabs');
const listEl = document.getElementById('driver-orders-list');

let driverPos = null;
let activeTab = 'available';
let latestOrders = [];
let cancellingId = null;
let deliveringId = null;

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
    locationStatus.textContent = `Location set (±GPS) — ${driverPos.lat.toFixed(3)}, ${driverPos.lon.toFixed(3)}`;
    locationStatus.className = 'location-status ok';
  } catch {
    locationStatus.textContent = 'Location unavailable — enter your postcode instead:';
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
  tabsEl.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
  render();
});

// Phase B hardening — real numeric coordinates only. A resolved branch can
// still have null lat/lon (never required by Phase A/B), and since 0018 a
// branch can legitimately fail to resolve at all (getBranch returns null —
// its supplier or the branch itself went inactive after an in-flight
// order's stockistId was snapshotted). Never coerce a missing coordinate
// into 0,0 (JS's `null - lat` silently does exactly that) — return null,
// never Infinity/NaN, whenever either point isn't a real coordinate.
function safeDistanceKm(a, b) {
  if (!a || !b || !Number.isFinite(a.lat) || !Number.isFinite(a.lon) || !Number.isFinite(b.lat) || !Number.isFinite(b.lon)) {
    return null;
  }
  return distanceKm(a, b);
}

// Defensive fallback only — every order should already carry the stockistId
// the worker chose at creation. Kept in case that's ever missing.
function nearestBranchFor(order, from) {
  const product = getProduct(order.productId);
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

// Phase B hardening — order.stockistId can now legitimately fail to
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
  const communityId = getActiveCommunityId();
  const orders = latestOrders.filter(o => o.communityId === communityId);
  let filtered;
  if (activeTab === 'available') {
    filtered = orders.filter(o => o.status === 'purchased');
  } else if (activeTab === 'mine') {
    filtered = orders.filter(o => o.driverId === currentDriverId() && ['claimed', 'collected'].includes(o.status));
  } else {
    filtered = orders.filter(o => o.status === 'delivered' && o.driverId === currentDriverId());
  }

  if (filtered.length === 0) {
    listEl.innerHTML = `<p class="empty-hint">Nothing here right now.</p>`;
    return;
  }

  const withDistance = filtered.map(o => ({ order: o, pickup: resolvePickup(o, driverPos) }));

  if (activeTab === 'available') {
    if (driverPos) {
      withDistance.sort((a, b) => (a.pickup?.distanceKm ?? Infinity) - (b.pickup?.distanceKm ?? Infinity));
    } else {
      withDistance.sort((a, b) => a.order.createdAt - b.order.createdAt);
    }
  }

  const locationHint = activeTab === 'available' && !driverPos
    ? '<p class="empty-hint">Set your current location above to sort these by distance.</p>'
    : '';

  listEl.innerHTML = locationHint + withDistance.map(({ order, pickup }) => renderOrderCard(order, pickup)).join('');

  listEl.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', () => handleAction(btn.dataset.action, btn.dataset.id));
  });

  const reasonInput = listEl.querySelector('#cancel-reason-input');
  if (reasonInput) reasonInput.focus();
  const deliveryLocationInput = listEl.querySelector('#delivery-location-input');
  if (deliveryLocationInput) deliveryLocationInput.focus();
}

const STATUS_LABELS = {
  purchased: 'Ready for pickup',
  claimed: 'Claimed by you',
  collected: 'Collected — in transit',
  delivered: 'Delivered',
};

function renderOrderCard(order, pickup) {
  const branch = pickup?.branch;
  const dist = pickup?.distanceKm;
  const deliveryDist = branch
    ? safeDistanceKm(branch, { lat: order.deliveryLat, lon: order.deliveryLon })
    : null;
  // Phase B hardening — when the live branch can't be resolved (deactivated
  // since this order's stockistId was snapshotted), fall back to the
  // order's own point-in-time snapshot fields rather than showing nothing —
  // historical/in-flight order display must never depend on a live supplier
  // row. Pickup distance has no snapshot substitute, so it's simply omitted
  // (Number.isFinite below), matching how this card already silently omits
  // it when the Driver hasn't set a location — never "Infinity"/"NaN".
  const buyFromName = branch ? branch.name : (order.stockistName || 'Unknown');
  const buyFromSub = branch
    ? `${branch.website} &middot; ${branch.postcode}`
    : [order.stockistWebsite, order.stockistPostcode].filter(Boolean).join(' &middot; ');

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

  const requesterName = order.requestedBy || 'Unknown';

  return `
    <div class="order-card driver-card status-${order.status}" data-order-id="${order.id}">
      <div class="request-header">
        <div class="requester-badge" title="Requested by ${requesterName}">
          <span class="requester-avatar">${getInitials(requesterName)}</span>
          <span class="requester-name">${requesterName}</span>
        </div>
        <div class="order-card-main">
          <strong>${order.productName}${order.variant ? ` (${order.variant})` : ''}</strong>
          <span>${order.quantity} × ${order.unit}</span>
        </div>
      </div>
      <div class="driver-route">
        <div class="route-step">
          <span class="route-label">Buy from</span>
          <span class="route-value">${buyFromName}</span>
          ${buyFromSub ? `<span class="route-sub">${buyFromSub}</span>` : ''}
          ${order.pickupEstimate ? `<span class="route-sub route-pickup-estimate">${order.pickupEstimate}</span>` : ''}
          ${Number.isFinite(dist) ? `<span class="route-dist">${dist.toFixed(1)} km from you</span>` : ''}
        </div>
        <div class="route-arrow">&rarr;</div>
        <div class="route-step">
          <span class="route-label">Deliver to</span>
          <span class="route-value">${order.siteName || order.deliveryPostcode}</span>
          ${order.siteName ? `<span class="route-sub">${[order.siteAddress, order.sitePostcode].filter(Boolean).join(' · ') || order.deliveryPostcode}</span>` : ''}
          ${order.siteDeliveryInstructions ? `<span class="route-sub">📋 ${order.siteDeliveryInstructions}</span>` : ''}
          ${Number.isFinite(deliveryDist) ? `<span class="route-dist">${deliveryDist.toFixed(1)} km from pickup</span>` : ''}
        </div>
      </div>
      <span class="status-badge status-${order.status}">${STATUS_LABELS[order.status] || order.status}</span>
      ${order.status === 'delivered' && order.deliveryLocation
        ? `<p class="hint small-hint">Delivered to ${order.deliveryLocation} at ${new Date(order.deliveryTime).toLocaleString()}</p>` : ''}
      ${actionHtml}
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
    actionInFlight = true;
    result = await deliverOrder(orderId, new Date(timeVal).getTime(), locationVal);
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
  tabsEl.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === 'available'));
  render();
}

subscribe(orders => {
  latestOrders = orders;
  render();
});
