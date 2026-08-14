import { formatPrice, getInitials, getCategoryIcon, getProduct, timeAgo } from './data.js';
import { subscribe } from './store.js';
import {
  getActiveCommunityId, getJoinRequests, decideJoinRequest, subscribeCommunities,
  approvedMemberCount, isCreator, isOwner, approvedMembers, hasOwnerGrant, grantOwnerAccess, revokeOwnerAccess,
  hasBuyerGrant, grantBuyerAccess, revokeBuyerAccess, getBuyerRequests, decideBuyerRequest,
  isApprovalRequired, setApprovalRequired,
} from './community.js';
import { getCurrentUserId, getCurrentDisplayName, resolveDisplayName } from './identity.js';
import {
  approveOrder, rejectOrder, revertApproval, getEventsForCommunity, subscribeOrderEvents, REVERT_WINDOW_MS,
} from './orderLifecycle.js';

const tabsEl = document.getElementById('owner-tabs');
const listEl = document.getElementById('owner-orders-list');
const joinRequestsPanel = document.getElementById('owner-join-requests-panel');
const joinRequestsList = document.getElementById('owner-join-requests-list');
const buyerRequestsPanel = document.getElementById('owner-buyer-requests-panel');
const buyerRequestsList = document.getElementById('owner-buyer-requests-list');
const teamPanel = document.getElementById('owner-team-panel');
const teamList = document.getElementById('owner-team-list');
const dashboardStatsEl = document.getElementById('dashboard-stats');
const dashboardActivityEl = document.getElementById('dashboard-activity');
const approvalToggle = document.getElementById('approval-required-toggle');

let activeTab = 'awaiting';
let latestOrders = [];
let rejectingId = null;

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
  if (!order.approvalWasRequired) {
    return `<p class="revert-note">This order skipped owner approval (setting was off when it was created)</p>`;
  }
  if (order.status !== 'pending_purchase' && order.status !== 'rejected') {
    return `<p class="revert-note revert-final">Once purchased, orders can't be reverted</p>`;
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
  return getCurrentDisplayName() || 'Unnamed owner';
}

function currentOwnerId() {
  return getCurrentUserId();
}

tabsEl.addEventListener('click', e => {
  const btn = e.target.closest('.tab-btn');
  if (!btn) return;
  activeTab = btn.dataset.tab;
  rejectingId = null;
  tabsEl.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
  render();
});

approvalToggle.addEventListener('change', () => {
  const communityId = getActiveCommunityId();
  if (!communityId) return;
  setApprovalRequired(communityId, approvalToggle.checked);
});

const EVENT_RENDER = {
  order_created: (e, label) => ({ icon: '📝', text: `${e.actorName || 'Someone'} requested ${label}` }),
  approved: (e, label) => ({ icon: '✅', text: `${e.actorName || 'Owner'} approved ${label}` }),
  rejected: (e, label) => ({ icon: '🚫', text: `${e.actorName || 'Owner'} rejected ${label}${e.reason ? ` — ${e.reason}` : ''}` }),
  approval_reverted: (e, label) => ({ icon: '↩️', text: `${e.actorName || 'Owner'} reverted the decision on ${label}` }),
  purchase_started: (e, label) => ({ icon: '🛒', text: `${e.actorName || 'A buyer'} started purchasing ${label}` }),
  purchase_abandoned: (e, label) => ({ icon: '↩️', text: `${e.actorName || 'A buyer'} released ${label} back to the purchase queue` }),
  purchased: (e, label) => ({ icon: '💳', text: `${e.actorName || 'A buyer'} purchased ${label}` }),
  delivery_claimed: (e, label) => ({ icon: '🚚', text: `${e.actorName || 'A driver'} claimed ${label}` }),
  delivery_cancelled: (e, label) => ({ icon: '⚠️', text: `${e.actorName || 'A driver'} cancelled ${label}${e.reason ? ` — ${e.reason}` : ''}` }),
  delivery_returned_to_pool: (e, label) => ({ icon: '🔁', text: `${label} is back in the driver pool` }),
  collected: (e, label) => ({ icon: '📦', text: `${e.actorName || 'Driver'} collected ${label}` }),
  delivered: (e, label) => ({ icon: '🏁', text: `${label} delivered to ${e.meta?.deliveryLocation || 'site'}` }),
};

function renderDashboard(inCommunity, communityId) {
  const pendingJoinCount = getJoinRequests().filter(r => r.communityId === communityId && r.status === 'pending').length;
  const awaitingApproval = inCommunity.filter(o => o.status === 'pending_approval').length;
  const outForDelivery = inCommunity.filter(o => o.status === 'claimed' || o.status === 'collected').length;
  const delivered = inCommunity.filter(o => o.status === 'delivered').length;
  const totalSpend = inCommunity
    .filter(o => o.purchasedAt != null)
    .reduce((sum, o) => sum + (o.totalPrice || 0), 0);

  const tiles = [
    { value: approvedMemberCount(communityId), label: 'Members' },
    { value: pendingJoinCount, label: 'Pending Join Requests', highlight: pendingJoinCount > 0 },
    { value: awaitingApproval, label: 'Awaiting Order Approval', highlight: awaitingApproval > 0 },
    { value: outForDelivery, label: 'Out for Delivery' },
    { value: delivered, label: 'Delivered' },
    { value: formatPrice(totalSpend), label: 'Total Spend (Purchased)' },
  ];

  dashboardStatsEl.innerHTML = tiles.map(t => `
    <div class="stat-tile${t.highlight ? ' stat-tile-highlight' : ''}">
      <span class="stat-value">${t.value}</span>
      <span class="stat-label">${t.label}</span>
    </div>
  `).join('');

  const events = getEventsForCommunity(communityId);
  dashboardActivityEl.innerHTML = events.length === 0
    ? '<p class="empty-hint">Nothing has happened yet.</p>'
    : events.slice(0, 8).map(e => {
      const order = inCommunity.find(o => o.id === e.orderId);
      const label = order ? `${order.productName}${order.variant ? ` (${order.variant})` : ''}` : 'an order';
      const render = EVENT_RENDER[e.type];
      const { icon, text } = render ? render(e, label) : { icon: '•', text: `${e.type} on ${label}` };
      return `
        <div class="activity-item">
          <span class="activity-icon" aria-hidden="true">${icon}</span>
          <span class="activity-text">${text}</span>
          <span class="activity-time">${timeAgo(e.createdAt)}</span>
        </div>
      `;
    }).join('');
}

function renderApprovalSetting(communityId) {
  approvalToggle.checked = isApprovalRequired(communityId);
}

function renderTeam(communityId) {
  const userId = currentOwnerId();
  if (!isOwner(communityId, userId)) {
    teamPanel.hidden = true;
    return;
  }
  const viewerIsCreator = isCreator(communityId, userId);

  const members = approvedMembers(communityId).filter(id => id !== userId);
  teamPanel.hidden = false;

  if (members.length === 0) {
    teamList.innerHTML = '<p class="empty-hint">No other members yet — approve some join requests first.</p>';
    return;
  }

  teamList.innerHTML = members.map(memberId => {
    const displayName = resolveDisplayName(memberId);
    const ownerGranted = hasOwnerGrant(communityId, memberId);
    const buyerGranted = hasBuyerGrant(communityId, memberId);
    const badges = [ownerGranted ? 'Owner access' : null, buyerGranted ? 'Buyer access' : null].filter(Boolean);
    return `
      <div class="order-card">
        <div class="request-header">
          <div class="requester-badge" title="${displayName}">
            <span class="requester-avatar">${getInitials(displayName)}</span>
            <span class="requester-name">${displayName}</span>
          </div>
          <div class="order-card-main">
            <strong>${badges.length ? badges.join(' + ') : 'Member'}</strong>
          </div>
        </div>
        <div class="owner-actions">
          ${viewerIsCreator ? (ownerGranted
            ? `<button class="btn btn-secondary" data-team-action="revoke-owner" data-team-id="${memberId}">Revoke owner access</button>`
            : `<button class="btn btn-primary" data-team-action="grant-owner" data-team-id="${memberId}">Give owner access</button>`) : ''}
          ${buyerGranted
            ? `<button class="btn btn-secondary" data-team-action="revoke-buyer" data-team-id="${memberId}">Revoke buyer access</button>`
            : `<button class="btn btn-primary" data-team-action="grant-buyer" data-team-id="${memberId}">Give buyer access</button>`}
        </div>
      </div>
    `;
  }).join('');

  teamList.querySelectorAll('[data-team-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const memberId = btn.dataset.teamId;
      const action = btn.dataset.teamAction;
      if (action === 'grant-owner') grantOwnerAccess(communityId, memberId, userId);
      else if (action === 'revoke-owner') revokeOwnerAccess(communityId, memberId);
      else if (action === 'grant-buyer') grantBuyerAccess(communityId, memberId, userId);
      else if (action === 'revoke-buyer') revokeBuyerAccess(communityId, memberId, userId);
    });
  });
}

function render() {
  const communityId = getActiveCommunityId();
  if (!communityId) return;

  renderJoinRequests(communityId);
  renderBuyerRequests(communityId);
  renderApprovalSetting(communityId);

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

function renderJoinRequests(communityId) {
  const pending = getJoinRequests().filter(r => r.communityId === communityId && r.status === 'pending');
  joinRequestsPanel.hidden = pending.length === 0;
  if (pending.length === 0) return;

  joinRequestsList.innerHTML = pending.map(r => {
    const displayName = resolveDisplayName(r.userId);
    return `
    <div class="order-card">
      <div class="request-header">
        <div class="requester-badge" title="${displayName}">
          <span class="requester-avatar">${getInitials(displayName)}</span>
          <span class="requester-name">${displayName}</span>
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
  `;
  }).join('');

  joinRequestsList.querySelectorAll('[data-join-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const decision = btn.dataset.joinAction === 'approve' ? 'approved' : 'declined';
      decideJoinRequest(btn.dataset.joinId, decision, currentOwnerId());
    });
  });
}

function renderBuyerRequests(communityId) {
  const pending = getBuyerRequests().filter(r => r.communityId === communityId && r.status === 'pending');
  buyerRequestsPanel.hidden = pending.length === 0;
  if (pending.length === 0) return;

  buyerRequestsList.innerHTML = pending.map(r => {
    const displayName = resolveDisplayName(r.userId);
    return `
    <div class="order-card">
      <div class="request-header">
        <div class="requester-badge" title="${displayName}">
          <span class="requester-avatar">${getInitials(displayName)}</span>
          <span class="requester-name">${displayName}</span>
        </div>
        <div class="order-card-main">
          <strong>Wants buyer access</strong>
        </div>
      </div>
      <div class="owner-actions">
        <button class="btn btn-secondary" data-buyer-req-action="declined" data-req-id="${r.id}">Decline</button>
        <button class="btn btn-primary" data-buyer-req-action="approved" data-req-id="${r.id}">Approve</button>
      </div>
    </div>
  `;
  }).join('');

  buyerRequestsList.querySelectorAll('[data-buyer-req-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      decideBuyerRequest(btn.dataset.reqId, btn.dataset.buyerReqAction, currentOwnerId());
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
    <div class="order-card driver-card status-${order.status}" data-order-id="${order.id}">
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
          <span class="route-value">${order.siteName || order.deliveryPostcode}</span>
          ${order.siteName ? `<span class="route-sub">${[order.siteAddress, order.sitePostcode].filter(Boolean).join(' · ') || order.deliveryPostcode}</span>` : ''}
        </div>
      </div>
      ${order.status === 'rejected' ? `<p class="rejection-reason">Rejected by ${order.rejectedBy || 'owner'}${order.rejectionReason ? `: ${order.rejectionReason}` : ''}</p>` : ''}
      ${order.status === 'purchased' || order.status === 'claimed' || order.status === 'collected' || order.status === 'delivered'
        ? `<p class="hint small-hint">Purchased by ${order.purchasedBy || 'a buyer'}${order.driver ? ` &middot; driver: ${order.driver}` : ''}</p>` : ''}
      ${order.cancelledAt ? `<p class="rejection-reason">Cancelled by ${order.cancelledBy || 'a driver'}: ${order.cancellationReason || ''}</p>` : ''}
      ${order.status === 'delivered' && order.deliveryLocation
        ? `<p class="hint small-hint">Delivered to ${order.deliveryLocation} at ${new Date(order.deliveryTime).toLocaleString()} (confirmed by ${order.driver || 'driver'})</p>` : ''}
      ${actionHtml}
    </div>
  `;
}

function handleAction(action, orderId) {
  const actorId = currentOwnerId();
  const actorName = currentOwnerName();

  let result;
  if (action === 'approve') {
    result = approveOrder(orderId, actorId, actorName);
  } else if (action === 'reject') {
    rejectingId = orderId;
    render();
    return;
  } else if (action === 'cancel-reject') {
    rejectingId = null;
    render();
    return;
  } else if (action === 'confirm-reject') {
    const reasonInput = document.getElementById('reject-reason-input');
    const reason = reasonInput ? reasonInput.value.trim() : '';
    result = rejectOrder(orderId, actorId, actorName, reason);
    rejectingId = null;
  } else if (action === 'revert') {
    result = revertApproval(orderId, actorId, actorName);
  }

  if (result && !result.ok) {
    alert(result.error);
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
subscribeOrderEvents(render);

// Keep the revert countdowns ticking even when nothing else changes.
setInterval(() => {
  if (activeTab === 'approved' || activeTab === 'rejected') render();
}, 60000);
