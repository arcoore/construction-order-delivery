import { formatPrice, getInitials, getCategoryIcon, timeAgo } from './data.js';
import { getProduct } from './products.js';
import {
  getActiveCommunityId, getJoinRequests, decideJoinRequest, subscribeCommunities,
  approvedMemberCount, isCreator, isOwner, approvedMembers, hasOwnerGrant, grantOwnerAccess, revokeOwnerAccess,
  hasBuyerGrant, grantBuyerAccess, revokeBuyerAccess, getBuyerRequests, decideBuyerRequest,
  isApprovalRequired, setApprovalRequired,
} from './community.js';
import { getCurrentUserId, getCurrentDisplayName, resolveDisplayName } from './identity.js';
import {
  subscribe, approveOrder, rejectOrder, revertApproval, getEventsForCommunity, getOrderEvents, subscribeOrderEvents, REVERT_WINDOW_MS,
  getPendingCancellationRequestForOrder, subscribeCancellationRequests,
} from './orderLifecycle.js';
// Phase 8E — read-only reuse of sites.js's existing data functions for the
// dashboard's Sites summary card. No site CRUD/permission logic lives here;
// creating/editing/archiving/assigning all still happens exclusively in
// sitesView.js, reached via the sitestock:show-sites event below.
import { subscribeSites, getActiveSites, getSiteMembers } from './sites.js';
import { formatNeededBy, neededByUrgency, urgencyLabel } from './deadline.js';
import { statusLabel, nextActionFor, urgencyComparator, describeEvent } from './orderStatus.js';

const tabsEl = document.getElementById('owner-tabs');
const ordersPanel = document.getElementById('owner-orders-panel');
const listEl = document.getElementById('owner-orders-list');
const orderDetailPanel = document.getElementById('owner-order-detail-panel');
const orderDetailEl = document.getElementById('owner-order-detail');
const orderDetailBackBtn = document.getElementById('owner-order-detail-back-btn');
const joinRequestsPanel = document.getElementById('owner-join-requests-panel');
const joinRequestsList = document.getElementById('owner-join-requests-list');
const buyerRequestsPanel = document.getElementById('owner-buyer-requests-panel');
const buyerRequestsList = document.getElementById('owner-buyer-requests-list');
const teamPanel = document.getElementById('owner-team-panel');
const teamList = document.getElementById('owner-team-list');
const dashboardStatsEl = document.getElementById('dashboard-stats');
const dashboardActivityEl = document.getElementById('dashboard-activity');
const approvalToggle = document.getElementById('approval-required-toggle');
const sitesSummaryListEl = document.getElementById('owner-sites-summary-list');
const newSiteBtn = document.getElementById('owner-new-site-btn');
const manageSitesBtn = document.getElementById('owner-manage-sites-btn');

// Groups the existing order.status values into the tabs an owner actually
// needs to scan for "what needs attention" — no new statuses, this is a
// pure UI regrouping of the same lifecycle already enforced by
// orderLifecycle.js's TRANSITIONS table.
const TAB_GROUPS = {
  awaiting: ['pending_approval'],
  purchase: ['pending_purchase', 'purchase_in_progress'],
  purchased: ['purchased'],
  delivery: ['claimed', 'collected'],
  delivered: ['delivered'],
  rejected: ['rejected'],
  // Kept separate from rejected on purpose (Phase 7C) — rejected means the
  // Owner said no; cancelled means the Worker withdrew it, sometimes after
  // money was spent. Same accountability distinction the rest of Phase 7
  // preserves.
  cancelled: ['cancelled'],
};

let activeTab = 'awaiting';
let latestOrders = [];
let rejectingId = null;
let selectedOrderId = null;

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
      const { icon, text } = describeEvent(e, label);
      return `
        <div class="activity-item">
          <span class="activity-icon" aria-hidden="true">${icon}</span>
          <span class="activity-text">${text}</span>
          <span class="activity-time">${timeAgo(e.createdAt)}</span>
        </div>
      `;
    }).join('');
}

// Phase 8E — "enter a Community, immediately see its Sites" (see
// CLAUDE.md's Site model / PROGRESS.md Phase 8E entry): a compact,
// read-only summary of the community's active sites, right on the
// dashboard. All CRUD/detail/member-assignment stays in sitesView.js —
// clicking a row or "+ New site"/"Manage all Sites" just navigates there
// (optionally deep-linked to one site), it never duplicates that logic here.
function renderSitesSummary(communityId, inCommunity) {
  const sites = getActiveSites(communityId).sort((a, b) => a.name.localeCompare(b.name));

  if (sites.length === 0) {
    sitesSummaryListEl.innerHTML = '<p class="empty-hint">No sites yet — create the first one below.</p>';
    return;
  }

  sitesSummaryListEl.innerHTML = sites.slice(0, 5).map(s => {
    const memberCount = getSiteMembers(s.id).length;
    const openCount = inCommunity.filter(o =>
      o.siteId === s.id && !['delivered', 'rejected', 'cancelled'].includes(o.status)
    ).length;
    return `
      <button type="button" class="result-card" data-summary-site-id="${s.id}">
        <span class="result-name">${s.name}</span>
        <span class="result-meta">${memberCount} ${memberCount === 1 ? 'employee' : 'employees'} &middot; ${openCount} open order${openCount === 1 ? '' : 's'}</span>
      </button>
    `;
  }).join('');

  sitesSummaryListEl.querySelectorAll('[data-summary-site-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('sitestock:show-sites', { detail: { siteId: btn.dataset.summarySiteId } }));
    });
  });
}

newSiteBtn.addEventListener('click', () => {
  window.dispatchEvent(new CustomEvent('sitestock:show-sites'));
});

manageSitesBtn.addEventListener('click', () => {
  window.dispatchEvent(new CustomEvent('sitestock:show-sites'));
});

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
  renderSitesSummary(communityId, inCommunity);
  renderTeam(communityId);

  if (selectedOrderId) {
    const order = inCommunity.find(o => o.id === selectedOrderId);
    if (!order) {
      showOrdersList();
    } else {
      renderOrderDetail(order);
    }
    return;
  }

  const statuses = TAB_GROUPS[activeTab] || [];
  let filtered = inCommunity.filter(o => statuses.includes(o.status));

  // Roadmap Step 4 — only the two tabs something is genuinely waiting on
  // (awaiting Owner approval, waiting for a buyer to purchase) get
  // urgency-first ordering; every other tab is tracking/history, where
  // newest-first is still the more useful read (unchanged from before).
  filtered = [...filtered].sort(
    activeTab === 'awaiting' || activeTab === 'purchase'
      ? urgencyComparator
      : (a, b) => b.createdAt - a.createdAt
  );

  if (filtered.length === 0) {
    listEl.innerHTML = '<p class="empty-hint">Nothing here right now.</p>';
    return;
  }

  listEl.innerHTML = filtered.map(renderOrderCard).join('');

  listEl.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', () => handleAction(btn.dataset.action, btn.dataset.id));
  });

  listEl.querySelectorAll('[data-detail-id]').forEach(btn => {
    btn.addEventListener('click', () => showOrderDetail(btn.dataset.detailId));
  });

  const reasonInput = listEl.querySelector('#reject-reason-input');
  if (reasonInput) reasonInput.focus();
}

function showOrderDetail(orderId) {
  selectedOrderId = orderId;
  ordersPanel.hidden = true;
  orderDetailPanel.hidden = false;
  render();
}

function showOrdersList() {
  selectedOrderId = null;
  orderDetailPanel.hidden = true;
  ordersPanel.hidden = false;
  render();
}

orderDetailBackBtn.addEventListener('click', showOrdersList);

// Read-only accountability view: everything shown here is either a field
// already sitting on the order or an event already sitting in the
// append-only log from orderLifecycle.js — no new history system, no
// editing, no lifecycle actions.
function renderOrderDetail(order) {
  const product = getProduct(order.productId);
  const label = `${order.productName}${order.variant ? ` (${order.variant})` : ''}`;
  const events = getOrderEvents(order.id);

  const peopleRows = [
    order.requestedBy ? `<p class="hint"><strong>Requested by</strong> ${order.requestedBy}</p>` : '',
    order.approvedBy ? `<p class="hint"><strong>Approved by</strong> ${order.approvedBy}</p>` : '',
    order.rejectedBy ? `<p class="hint"><strong>Rejected by</strong> ${order.rejectedBy}${order.rejectionReason ? ` — ${order.rejectionReason}` : ''}</p>` : '',
    order.purchasedBy ? `<p class="hint"><strong>Purchased by</strong> ${order.purchasedBy}</p>` : '',
    order.driver ? `<p class="hint"><strong>Driver</strong> ${order.driver}</p>` : '',
    order.cancelledBy ? `<p class="hint"><strong>Delivery cancelled by</strong> ${order.cancelledBy}${order.cancellationReason ? ` — ${order.cancellationReason}` : ''}</p>` : '',
    order.orderCancelledBy ? `<p class="hint"><strong>Cancelled by</strong> ${order.orderCancelledBy}${order.orderCancellationReason ? ` — ${order.orderCancellationReason}` : ''}</p>` : '',
  ].filter(Boolean).join('');

  const pendingCancellation = !!getPendingCancellationRequestForOrder(order.id);
  const nextAction = nextActionFor(order, 'owner', { pendingCancellationRequest: pendingCancellation });
  const urgency = neededByUrgency(order.neededByType, order.neededBy, order.status);
  const urgencyWord = urgencyLabel(urgency);

  orderDetailEl.innerHTML = `
    <h1>${label}</h1>
    <span class="status-badge status-${order.status}">${statusLabel(order.status, 'owner')}</span>
    ${nextAction ? `<span class="order-next-action">${nextAction}</span>` : ''}

    <div class="product-preview">
      <div class="product-preview-icon" aria-hidden="true">${product ? getCategoryIcon(product.category) : '📦'}</div>
      <div class="product-preview-info">
        <strong>${label}</strong>
        <span>${order.quantity} &times; ${order.unit}${order.totalPrice != null ? ` &middot; ${formatPrice(order.totalPrice)} (${formatPrice(order.unitPrice)} each)` : ''}</span>
        <span class="order-needed-by${urgency !== 'none' && urgency !== 'future' ? ` urgency-${urgency}` : ''}">Needed by: ${formatNeededBy(order.neededByType, order.neededBy)}${urgencyWord ? ` &middot; ${urgencyWord}` : ''}</span>
      </div>
    </div>

    <h2>Site</h2>
    <p class="hint">${order.siteName || 'Unknown site'}${[order.siteAddress, order.sitePostcode].filter(Boolean).length ? `<br>${[order.siteAddress, order.sitePostcode].filter(Boolean).join(' · ')}` : ''}${order.siteDeliveryInstructions ? `<br>${order.siteDeliveryInstructions}` : ''}</p>

    <h2>Sourcing</h2>
    <p class="hint">${order.stockistName || 'Not yet chosen'}${order.stockistWebsite ? ` &middot; ${order.stockistWebsite}` : ''}${order.stockistPostcode ? ` &middot; ${order.stockistPostcode}` : ''}</p>

    <h2>People</h2>
    ${peopleRows || '<p class="empty-hint">No actions taken yet.</p>'}

    ${order.status === 'delivered' ? `
      <h2>Delivery</h2>
      <p class="hint">Delivered to ${order.deliveryLocation || 'an unrecorded location'} at ${order.deliveryTime ? new Date(order.deliveryTime).toLocaleString() : 'an unrecorded time'}${order.deliveredAt ? ` &middot; confirmed ${new Date(order.deliveredAt).toLocaleString()}` : ''}.</p>
    ` : ''}

    <h2>Timeline</h2>
    <div class="activity-list">
      ${events.length === 0 ? '<p class="empty-hint">No events recorded.</p>' : events.map(e => {
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
  const pendingCancellation = !!getPendingCancellationRequestForOrder(order.id);
  const nextAction = nextActionFor(order, 'owner', { pendingCancellationRequest: pendingCancellation });
  const urgency = neededByUrgency(order.neededByType, order.neededBy, order.status);
  const urgencyWord = urgencyLabel(urgency);

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
  } else if (order.status === 'cancelled') {
    // No revert path for a cancelled order this phase — renderRevertSection
    // would otherwise show its generic "once purchased, orders can't be
    // reverted" message here, which reads as if a purchase happened even
    // when it didn't (e.g. cancelled while still pending_approval).
    actionHtml = '';
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
          <span class="order-needed-by${urgency !== 'none' && urgency !== 'future' ? ` urgency-${urgency}` : ''}">Needed by: ${formatNeededBy(order.neededByType, order.neededBy)}${urgencyWord ? ` &middot; ${urgencyWord}` : ''}</span>
        </div>
        <button type="button" class="link-btn order-detail-link" data-detail-id="${order.id}">View details &rarr;</button>
      </div>
      <span class="status-badge status-${order.status}">${statusLabel(order.status, 'owner')}</span>
      ${nextAction ? `<span class="order-next-action">${nextAction}</span>` : ''}
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
      ${order.status === 'cancelled' ? `<p class="rejection-reason">Cancelled by ${order.orderCancelledBy || 'the worker'}${order.orderCancellationReason ? `: ${order.orderCancellationReason}` : ''}</p>` : ''}
      ${order.status === 'purchased' || order.status === 'claimed' || order.status === 'collected' || order.status === 'delivered'
        ? `<p class="hint small-hint">Purchased by ${order.purchasedBy || 'a buyer'}${order.driver ? ` &middot; driver: ${order.driver}` : ''}</p>` : ''}
      ${order.cancelledAt ? `<p class="rejection-reason">Cancelled by ${order.cancelledBy || 'a driver'}: ${order.cancellationReason || ''}</p>` : ''}
      ${order.status === 'delivered' && order.deliveryLocation
        ? `<p class="hint small-hint">Delivered to ${order.deliveryLocation} at ${new Date(order.deliveryTime).toLocaleString()} (confirmed by ${order.driver || 'driver'})</p>` : ''}
      ${actionHtml}
    </div>
  `;
}

let actionInFlight = false;

async function handleAction(action, orderId) {
  if (action === 'reject') {
    rejectingId = orderId;
    render();
    return;
  }
  if (action === 'cancel-reject') {
    rejectingId = null;
    render();
    return;
  }

  if (actionInFlight) return;

  let result;
  if (action === 'approve') {
    actionInFlight = true;
    result = await approveOrder(orderId);
  } else if (action === 'confirm-reject') {
    const reasonInput = document.getElementById('reject-reason-input');
    const reason = reasonInput ? reasonInput.value.trim() : '';
    actionInFlight = true;
    result = await rejectOrder(orderId, reason);
    rejectingId = null;
  } else if (action === 'revert') {
    actionInFlight = true;
    result = await revertApproval(orderId);
  }
  actionInFlight = false;

  if (result && !result.ok) {
    alert(result.error);
  }
}

// Mirrors buyer.js's refreshBuyerView(orderId): an optional order id from a
// notification click opens straight into that order's existing read-only
// detail view (showOrderDetail below) instead of the default tab list. The
// order must be found in latestOrders AND belong to the *active* community —
// this is what keeps a stale or cross-community id from ever opening a
// detail view main.js's navigateToNotification hasn't already re-authorized
// (it already re-checks role/community/site access before ever setting
// pendingNotifOrderId; this is just the last-mile "does this order actually
// exist here" check, same discipline as every other id-is-not-permission
// check in this codebase).
export function refreshOwnerView(orderId = null) {
  activeTab = 'awaiting';
  rejectingId = null;
  tabsEl.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === 'awaiting'));

  const communityId = getActiveCommunityId();
  const target = orderId && communityId && latestOrders.find(o => o.id === orderId && o.communityId === communityId);
  if (target) {
    showOrderDetail(orderId);
  } else {
    showOrdersList();
  }
}

subscribe(orders => {
  latestOrders = orders;
  render();
});

subscribeCommunities(render);
subscribeOrderEvents(render);
subscribeSites(render);
// Roadmap Step 4 — a pending cancellation request now feeds the card's
// next-action line (getPendingCancellationRequestForOrder), so a live
// approve/reject/new-request change needs to re-render this view too.
subscribeCancellationRequests(render);

// Keep the revert countdowns ticking even when nothing else changes — only
// the tabs whose orders can actually show a live countdown (pending_purchase
// and rejected are the only statuses orderLifecycle.js's revert transition
// applies to).
setInterval(() => {
  if (activeTab === 'purchase' || activeTab === 'rejected') render();
}, 60000);
