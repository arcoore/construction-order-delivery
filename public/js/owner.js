import { formatPrice, getInitials, getCategoryIcon, getProduct, timeAgo } from './data.js';
import { subscribe, updateOrder } from './store.js';
import {
  getIdentityName, getActiveCommunityId, getJoinRequests, decideJoinRequest, subscribeCommunities,
  approvedMemberCount, isCreator, approvedMembers, hasOwnerGrant, grantOwnerAccess, revokeOwnerAccess,
} from './community.js';

const tabsEl = document.getElementById('owner-tabs');
const listEl = document.getElementById('owner-orders-list');
const joinRequestsPanel = document.getElementById('owner-join-requests-panel');
const joinRequestsList = document.getElementById('owner-join-requests-list');
const teamPanel = document.getElementById('owner-team-panel');
const teamList = document.getElementById('owner-team-list');
const dashboardStatsEl = document.getElementById('dashboard-stats');
const dashboardActivityEl = document.getElementById('dashboard-activity');

let activeTab = 'awaiting';
let latestOrders = [];
let rejectingId = null;

const REVERT_WINDOW_MS = 72 * 60 * 60 * 1000;

function getDecisionTime(order) {
  return order.approvedAt || order.rejectedAt || null;
}

function formatCountdown(ms) {
  const totalMinutes = Math.max(0, Math.floor(ms / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function renderRevertSection(order) {
  if (order.status === 'picked_up' || order.status === 'delivered') {
    return `<p class="revert-note revert-final">Once picked up from the supplier, orders can't be reverted</p>`;
  }
  const decidedAt = getDecisionTime(order);
  if (!decidedAt) return '';
  const remaining = REVERT_WINDOW_MS - (Date.now() - decidedAt);
  if (remaining <= 0) {
    return `<p class="revert-note revert-expired">72-hour revert window closed</p>`;
  }
  return `
    <div class="revert-section">
      <span class="revert-countdown">${formatCountdown(remaining)} left to revert</span>
      <button class="btn btn-secondary btn-small" data-action="revert" data-id="${order.id}">Revert decision</button>
    </div>
  `;
}

function currentOwnerName() {
  return getIdentityName() || 'Unnamed owner';
}

tabsEl.addEventListener('click', e => {
  const btn = e.target.closest('.tab-btn');
  if (!btn) return;
  activeTab = btn.dataset.tab;
  rejectingId = null;
  tabsEl.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
  render();
});

function renderDashboard(inCommunity, communityId) {
  const pendingJoinCount = getJoinRequests().filter(r => r.communityId === communityId && r.status === 'pending').length;
  const awaitingApproval = inCommunity.filter(o => o.status === 'pending_approval').length;
  const outForDelivery = inCommunity.filter(o => o.status === 'accepted' || o.status === 'picked_up').length;
  const delivered = inCommunity.filter(o => o.status === 'delivered').length;
  const totalSpend = inCommunity
    .filter(o => o.status !== 'pending_approval' && o.status !== 'rejected')
    .reduce((sum, o) => sum + (o.totalPrice || 0), 0);

  const tiles = [
    { value: approvedMemberCount(communityId), label: 'Members' },
    { value: pendingJoinCount, label: 'Pending Join Requests', highlight: pendingJoinCount > 0 },
    { value: awaitingApproval, label: 'Awaiting Order Approval', highlight: awaitingApproval > 0 },
    { value: outForDelivery, label: 'Out for Delivery' },
    { value: delivered, label: 'Delivered' },
    { value: formatPrice(totalSpend), label: 'Total Spend (Approved)' },
  ];

  dashboardStatsEl.innerHTML = tiles.map(t => `
    <div class="stat-tile${t.highlight ? ' stat-tile-highlight' : ''}">
      <span class="stat-value">${t.value}</span>
      <span class="stat-label">${t.label}</span>
    </div>
  `).join('');

  const events = [];
  inCommunity.forEach(o => {
    const itemLabel = `${o.productName}${o.variant ? ` (${o.variant})` : ''}`;
    events.push({ ts: o.createdAt, icon: '📝', text: `${o.requestedBy || 'Someone'} requested ${itemLabel}` });
    if (o.approvedAt) events.push({ ts: o.approvedAt, icon: '✅', text: `${o.approvedBy || 'Owner'} approved ${itemLabel}` });
    if (o.rejectedAt) events.push({ ts: o.rejectedAt, icon: '🚫', text: `${o.rejectedBy || 'Owner'} rejected ${itemLabel}${o.rejectionReason ? ` — ${o.rejectionReason}` : ''}` });
    if (o.acceptedAt) events.push({ ts: o.acceptedAt, icon: '🚚', text: `${o.driver || 'A driver'} accepted ${itemLabel}` });
    if (o.pickedUpAt) events.push({ ts: o.pickedUpAt, icon: '📦', text: `${o.driver || 'Driver'} picked up ${itemLabel}` });
    if (o.deliveredAt) events.push({ ts: o.deliveredAt, icon: '🏁', text: `${itemLabel} delivered to ${o.deliveryPostcode}` });
  });
  events.sort((a, b) => b.ts - a.ts);

  dashboardActivityEl.innerHTML = events.length === 0
    ? '<p class="empty-hint">Nothing has happened yet.</p>'
    : events.slice(0, 8).map(e => `
      <div class="activity-item">
        <span class="activity-icon" aria-hidden="true">${e.icon}</span>
        <span class="activity-text">${e.text}</span>
        <span class="activity-time">${timeAgo(e.ts)}</span>
      </div>
    `).join('');
}

function renderTeam(communityId) {
  const name = currentOwnerName();
  if (!isCreator(communityId, name)) {
    teamPanel.hidden = true;
    return;
  }

  const members = approvedMembers(communityId).filter(m => m.trim().toLowerCase() !== name.trim().toLowerCase());
  teamPanel.hidden = false;

  if (members.length === 0) {
    teamList.innerHTML = '<p class="empty-hint">No other members yet — approve some join requests first.</p>';
    return;
  }

  teamList.innerHTML = members.map(m => {
    const granted = hasOwnerGrant(communityId, m);
    return `
      <div class="order-card">
        <div class="request-header">
          <div class="requester-badge" title="${m}">
            <span class="requester-avatar">${getInitials(m)}</span>
            <span class="requester-name">${m}</span>
          </div>
          <div class="order-card-main">
            <strong>${granted ? 'Owner access granted' : 'Member'}</strong>
          </div>
        </div>
        <div class="owner-actions">
          ${granted
            ? `<button class="btn btn-secondary btn-block" data-team-action="revoke" data-team-name="${m}">Revoke owner access</button>`
            : `<button class="btn btn-primary btn-block" data-team-action="grant" data-team-name="${m}">Give owner access</button>`}
        </div>
      </div>
    `;
  }).join('');

  teamList.querySelectorAll('[data-team-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.teamAction === 'grant') {
        grantOwnerAccess(communityId, btn.dataset.teamName, name);
      } else {
        revokeOwnerAccess(communityId, btn.dataset.teamName);
      }
    });
  });
}

function render() {
  renderJoinRequests();

  const communityId = getActiveCommunityId();
  const inCommunity = latestOrders.filter(o => o.communityId === communityId);

  renderDashboard(inCommunity, communityId);
  renderTeam(communityId);

  let filtered;
  if (activeTab === 'awaiting') {
    filtered = inCommunity.filter(o => o.status === 'pending_approval');
  } else if (activeTab === 'approved') {
    filtered = inCommunity.filter(o => o.status !== 'pending_approval' && o.status !== 'rejected');
  } else {
    filtered = inCommunity.filter(o => o.status === 'rejected');
  }

  filtered = [...filtered].sort((a, b) => b.createdAt - a.createdAt);

  if (filtered.length === 0) {
    listEl.innerHTML = '<p class="empty-hint">Nothing here right now.</p>';
    return;
  }

  listEl.innerHTML = filtered.map(renderOrderCard).join('');

  listEl.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', () => handleAction(btn.dataset.action, btn.dataset.id));
  });

  const reasonInput = listEl.querySelector('#reject-reason-input');
  if (reasonInput) reasonInput.focus();
}

function renderJoinRequests() {
  const communityId = getActiveCommunityId();
  if (!communityId) {
    joinRequestsPanel.hidden = true;
    return;
  }
  const pending = getJoinRequests().filter(r => r.communityId === communityId && r.status === 'pending');
  joinRequestsPanel.hidden = pending.length === 0;
  if (pending.length === 0) return;

  joinRequestsList.innerHTML = pending.map(r => `
    <div class="order-card">
      <div class="request-header">
        <div class="requester-badge" title="${r.name}">
          <span class="requester-avatar">${getInitials(r.name)}</span>
          <span class="requester-name">${r.name}</span>
        </div>
        <div class="order-card-main">
          <strong>Wants to join this community</strong>
        </div>
      </div>
      <div class="owner-actions">
        <button class="btn btn-secondary" data-join-action="decline" data-join-id="${r.id}">Decline</button>
        <button class="btn btn-primary" data-join-action="approve" data-join-id="${r.id}">Approve</button>
      </div>
    </div>
  `).join('');

  joinRequestsList.querySelectorAll('[data-join-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const decision = btn.dataset.joinAction === 'approve' ? 'approved' : 'declined';
      decideJoinRequest(btn.dataset.joinId, decision, currentOwnerName());
    });
  });
}

function renderOrderCard(order) {
  const requesterName = order.requestedBy || 'Unknown';
  const product = getProduct(order.productId);

  let actionHtml = '';
  if (order.status === 'pending_approval') {
    if (rejectingId === order.id) {
      actionHtml = `
        <div class="reject-form">
          <label class="field-label" for="reject-reason-input">Reason (optional)</label>
          <input type="text" id="reject-reason-input" class="text-input" placeholder="e.g. Not needed this week" />
          <div class="reject-form-actions">
            <button class="btn btn-secondary" data-action="cancel-reject" data-id="${order.id}">Cancel</button>
            <button class="btn btn-primary" data-action="confirm-reject" data-id="${order.id}">Confirm rejection</button>
          </div>
        </div>
      `;
    } else {
      actionHtml = `
        <div class="owner-actions">
          <button class="btn btn-secondary" data-action="reject" data-id="${order.id}">Reject</button>
          <button class="btn btn-primary" data-action="approve" data-id="${order.id}">Approve</button>
        </div>
      `;
    }
  } else {
    actionHtml = renderRevertSection(order);
  }

  return `
    <div class="order-card driver-card status-${order.status}">
      <div class="request-header">
        <div class="requester-badge" title="Requested by ${requesterName}">
          <span class="requester-avatar">${getInitials(requesterName)}</span>
          <span class="requester-name">${requesterName}</span>
        </div>
        <div class="order-card-main">
          <span class="owner-product-icon" aria-hidden="true">${product ? getCategoryIcon(product.category) : '📦'}</span>
          <strong>${order.productName}${order.variant ? ` (${order.variant})` : ''}</strong>
          <span>${order.quantity} × ${order.unit}${order.totalPrice != null ? ` &middot; <span class="order-price">${formatPrice(order.totalPrice)}</span> (${formatPrice(order.unitPrice)} each)` : ''}</span>
        </div>
      </div>
      <div class="driver-route">
        <div class="route-step">
          <span class="route-label">Buy from</span>
          <span class="route-value">${order.stockistName || 'Unknown'}</span>
          ${order.stockistName ? `<span class="route-sub">${order.stockistWebsite} &middot; ${order.stockistPostcode}</span>` : ''}
          ${order.pickupEstimate ? `<span class="route-sub route-pickup-estimate">${order.pickupEstimate}</span>` : ''}
        </div>
        <div class="route-arrow">&rarr;</div>
        <div class="route-step">
          <span class="route-label">Deliver to</span>
          <span class="route-value">${order.deliveryPostcode}</span>
        </div>
      </div>
      ${order.status === 'rejected' ? `<p class="rejection-reason">Rejected by ${order.rejectedBy || 'owner'}${order.rejectionReason ? `: ${order.rejectionReason}` : ''}</p>` : ''}
      ${actionHtml}
    </div>
  `;
}

function handleAction(action, orderId) {
  if (action === 'approve') {
    updateOrder(orderId, {
      status: 'pending',
      approvedBy: currentOwnerName(),
      approvedAt: Date.now(),
    });
  } else if (action === 'reject') {
    rejectingId = orderId;
    render();
  } else if (action === 'cancel-reject') {
    rejectingId = null;
    render();
  } else if (action === 'confirm-reject') {
    const reasonInput = document.getElementById('reject-reason-input');
    const reason = reasonInput ? reasonInput.value.trim() : '';
    updateOrder(orderId, {
      status: 'rejected',
      rejectedBy: currentOwnerName(),
      rejectedAt: Date.now(),
      rejectionReason: reason || null,
    });
    rejectingId = null;
  } else if (action === 'revert') {
    updateOrder(orderId, {
      status: 'pending_approval',
      approvedBy: null,
      approvedAt: null,
      rejectedBy: null,
      rejectedAt: null,
      rejectionReason: null,
      driver: null,
      acceptedAt: null,
      pickedUpAt: null,
    });
  }
}

export function refreshOwnerView() {
  activeTab = 'awaiting';
  rejectingId = null;
  tabsEl.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === 'awaiting'));
  render();
}

subscribe(orders => {
  latestOrders = orders;
  render();
});

subscribeCommunities(render);

// Keep the revert countdowns ticking even when nothing else changes.
setInterval(() => {
  if (activeTab === 'approved' || activeTab === 'rejected') render();
}, 60000);
