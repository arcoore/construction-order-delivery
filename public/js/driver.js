import { getBranch, getProduct, formatPrice, getInitials } from './data.js';
import { distanceKm, getCurrentPosition, geocodePostcode } from './geo.js';
import { subscribe, updateOrder } from './store.js';
import { getIdentityName, getActiveCommunityId } from './community.js';

const locateBtn = document.getElementById('locate-btn');
const locationStatus = document.getElementById('location-status');
const tabsEl = document.getElementById('driver-tabs');
const listEl = document.getElementById('driver-orders-list');

let driverPos = null;
let activeTab = 'available';
let latestOrders = [];

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
  tabsEl.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
  render();
});

function nearestBranchFor(order, from) {
  const product = getProduct(order.productId);
  if (!product) return null;
  let best = null;
  let bestDist = Infinity;
  for (const bid of product.branchIds) {
    const branch = getBranch(bid);
    if (!branch) continue;
    const d = from ? distanceKm(from, branch) : null;
    if (from) {
      if (d < bestDist) {
        bestDist = d;
        best = branch;
      }
    } else if (!best) {
      best = branch;
    }
  }
  return best ? { branch: best, distanceKm: from ? bestDist : null } : null;
}

function currentDriverName() {
  return getIdentityName() || 'Unnamed driver';
}

function render() {
  const communityId = getActiveCommunityId();
  const orders = latestOrders.filter(o => o.communityId === communityId);
  let filtered;
  if (activeTab === 'available') {
    filtered = orders.filter(o => o.status === 'pending');
  } else if (activeTab === 'mine') {
    filtered = orders.filter(o => o.driver === currentDriverName() && ['accepted', 'picked_up'].includes(o.status));
  } else {
    filtered = orders.filter(o => o.status === 'delivered' && o.driver === currentDriverName());
  }

  if (filtered.length === 0) {
    listEl.innerHTML = `<p class="empty-hint">Nothing here right now.</p>`;
    return;
  }

  const withDistance = filtered.map(o => {
    const pickup = o.stockistId
      ? { branch: getBranch(o.stockistId), distanceKm: driverPos ? distanceKm(driverPos, getBranch(o.stockistId)) : null }
      : nearestBranchFor(o, driverPos);
    return { order: o, pickup };
  });

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
    btn.addEventListener('click', () => handleAction(btn.dataset.action, btn.dataset.id, btn.dataset.branchId));
  });
}

function renderOrderCard(order, pickup) {
  const branch = pickup?.branch;
  const dist = pickup?.distanceKm;
  const deliveryDist = branch && order.deliveryLat != null
    ? distanceKm(branch, { lat: order.deliveryLat, lon: order.deliveryLon })
    : null;

  let actionHtml = '';
  if (order.status === 'pending') {
    actionHtml = `<button class="btn btn-primary" data-action="accept" data-id="${order.id}" data-branch-id="${branch?.id ?? ''}">Accept &amp; buy this</button>`;
  } else if (order.status === 'accepted') {
    actionHtml = `<button class="btn btn-primary" data-action="picked_up" data-id="${order.id}">Mark picked up</button>`;
  } else if (order.status === 'picked_up') {
    actionHtml = `<button class="btn btn-primary" data-action="delivered" data-id="${order.id}">Mark delivered</button>`;
  }

  const requesterName = order.requestedBy || 'Unknown';

  return `
    <div class="order-card driver-card status-${order.status}">
      <div class="request-header">
        <div class="requester-badge" title="Requested by ${requesterName}">
          <span class="requester-avatar">${getInitials(requesterName)}</span>
          <span class="requester-name">${requesterName}</span>
        </div>
        <div class="order-card-main">
          <strong>${order.productName}${order.variant ? ` (${order.variant})` : ''}</strong>
          <span>${order.quantity} × ${order.unit}${order.totalPrice != null ? ` &middot; <span class="order-price">${formatPrice(order.totalPrice)}</span> (${formatPrice(order.unitPrice)} each)` : ''}</span>
        </div>
      </div>
      <div class="driver-route">
        <div class="route-step">
          <span class="route-label">Buy from</span>
          <span class="route-value">${branch ? branch.name : 'Unknown'}</span>
          ${branch ? `<span class="route-sub">${branch.website} &middot; ${branch.postcode}</span>` : ''}
          ${order.pickupEstimate ? `<span class="route-sub route-pickup-estimate">${order.pickupEstimate}</span>` : ''}
          ${dist != null ? `<span class="route-dist">${dist.toFixed(1)} km from you</span>` : ''}
        </div>
        <div class="route-arrow">&rarr;</div>
        <div class="route-step">
          <span class="route-label">Deliver to</span>
          <span class="route-value">${order.deliveryPostcode}</span>
          ${deliveryDist != null ? `<span class="route-dist">${deliveryDist.toFixed(1)} km from pickup</span>` : ''}
        </div>
      </div>
      ${actionHtml}
    </div>
  `;
}

function handleAction(action, orderId, branchId) {
  if (action === 'accept') {
    const branch = branchId ? getBranch(branchId) : null;
    updateOrder(orderId, {
      status: 'accepted',
      driver: currentDriverName(),
      stockistId: branch ? branch.id : null,
      stockistName: branch ? branch.name : null,
      stockistWebsite: branch ? branch.website : null,
      stockistPostcode: branch ? branch.postcode : null,
      acceptedAt: Date.now(),
    });
  } else if (action === 'picked_up') {
    updateOrder(orderId, { status: 'picked_up', pickedUpAt: Date.now() });
  } else if (action === 'delivered') {
    updateOrder(orderId, { status: 'delivered', deliveredAt: Date.now() });
  }
}

export function refreshDriverView() {
  activeTab = 'available';
  tabsEl.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === 'available'));
  render();
}

subscribe(orders => {
  latestOrders = orders;
  render();
});
