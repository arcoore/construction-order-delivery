import { getInitials, formatPrice, timeAgo } from './data.js';
import { subscribe } from './orderLifecycle.js';
import {
  subscribeSites, getSites, getSite, createSite, updateSite,
  archiveSite, restoreSite, getSiteMembers, isSiteMember, addSiteMember, removeSiteMember,
} from './sites.js';
import { getActiveCommunityId, approvedMembers, subscribeCommunities } from './community.js';
import { getCurrentUserId, resolveDisplayName } from './identity.js';

const listView = document.getElementById('sites-list-view');
const tabsEl = document.getElementById('sites-tabs');
const listEl = document.getElementById('sites-list');
const createNameInput = document.getElementById('site-name-input');
const createAddressInput = document.getElementById('site-address-input');
const createPostcodeInput = document.getElementById('site-postcode-input');
const createInstructionsInput = document.getElementById('site-instructions-input');
const createBtn = document.getElementById('create-site-btn');
const createStatusEl = document.getElementById('create-site-status');
const detailPanel = document.getElementById('site-detail-panel');
const detailEl = document.getElementById('site-detail');
const detailBackBtn = document.getElementById('site-detail-back-btn');

let activeTab = 'active';
let selectedSiteId = null;
let editingSite = false;
let latestOrders = [];

function currentActorId() {
  return getCurrentUserId();
}

function showList() {
  selectedSiteId = null;
  editingSite = false;
  detailPanel.hidden = true;
  listView.hidden = false;
  render();
}

function showDetail(siteId) {
  selectedSiteId = siteId;
  editingSite = false;
  listView.hidden = true;
  detailPanel.hidden = false;
  render();
}

detailBackBtn.addEventListener('click', showList);

tabsEl.addEventListener('click', e => {
  const btn = e.target.closest('.tab-btn');
  if (!btn) return;
  activeTab = btn.dataset.sitesTab;
  tabsEl.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
  render();
});

createBtn.addEventListener('click', async () => {
  const communityId = getActiveCommunityId();
  createBtn.disabled = true;
  createStatusEl.textContent = 'Creating…';
  createStatusEl.className = 'form-status';
  try {
    const result = await createSite(communityId, {
      name: createNameInput.value,
      address: createAddressInput.value,
      postcode: createPostcodeInput.value,
      deliveryInstructions: createInstructionsInput.value,
    }, currentActorId());

    if (!result.ok) {
      createStatusEl.textContent = result.error;
      createStatusEl.className = 'form-status error';
      return;
    }
    createNameInput.value = '';
    createAddressInput.value = '';
    createPostcodeInput.value = '';
    createInstructionsInput.value = '';
    createStatusEl.textContent = `"${result.site.name}" created.`;
    createStatusEl.className = 'form-status success';
  } finally {
    createBtn.disabled = false;
  }
});

function render() {
  if (!detailPanel.hidden && selectedSiteId) {
    renderDetail();
    return;
  }
  if (!listView.hidden) renderList();
}

function siteSummary(site) {
  const memberCount = getSiteMembers(site.id).length;
  const inSite = latestOrders.filter(o => o.siteId === site.id);
  const openCount = inSite.filter(o => o.status !== 'delivered' && o.status !== 'rejected').length;
  return { memberCount, openCount };
}

function renderList() {
  const communityId = getActiveCommunityId();
  if (!communityId) return;

  const sites = getSites(communityId)
    .filter(s => s.status === activeTab)
    .sort((a, b) => a.name.localeCompare(b.name));

  if (sites.length === 0) {
    listEl.innerHTML = `<p class="empty-hint">${activeTab === 'active' ? 'No sites yet — create one above.' : 'No archived sites.'}</p>`;
    return;
  }

  listEl.innerHTML = sites.map(s => {
    const { memberCount, openCount } = siteSummary(s);
    return `
      <button type="button" class="result-card" data-site-id="${s.id}">
        <span class="result-name">${s.name}</span>
        <span class="result-meta">${[s.address, s.postcode].filter(Boolean).join(' · ') || 'No address on file'}</span>
        <span class="result-meta">${memberCount} ${memberCount === 1 ? 'employee' : 'employees'} &middot; ${openCount} open order${openCount === 1 ? '' : 's'}</span>
      </button>
    `;
  }).join('');

  listEl.querySelectorAll('[data-site-id]').forEach(btn => {
    btn.addEventListener('click', () => showDetail(btn.dataset.siteId));
  });
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
  cancelled: 'Cancelled',
};

function renderSiteInfo(site) {
  if (editingSite) {
    return `
      <div class="reject-form">
        <label class="field-label" for="site-edit-name-input">Site name</label>
        <input type="text" id="site-edit-name-input" class="text-input" value="${site.name}" />
        <label class="field-label" for="site-edit-address-input">Address</label>
        <input type="text" id="site-edit-address-input" class="text-input" value="${site.address}" />
        <label class="field-label" for="site-edit-postcode-input">Postcode</label>
        <input type="text" id="site-edit-postcode-input" class="text-input" value="${site.postcode}" />
        <label class="field-label" for="site-edit-instructions-input">Delivery instructions</label>
        <input type="text" id="site-edit-instructions-input" class="text-input" value="${site.deliveryInstructions || ''}" />
        <p id="site-edit-status" class="form-status"></p>
        <div class="reject-form-actions">
          <button class="btn btn-secondary" id="site-edit-cancel-btn">Cancel</button>
          <button class="btn btn-primary" id="site-edit-save-btn">Save Changes</button>
        </div>
      </div>
    `;
  }

  return `
    <div class="profile-field">
      <span class="profile-label">Address</span>
      <span class="profile-value">${site.address || '—'}</span>
    </div>
    <div class="profile-field">
      <span class="profile-label">Postcode</span>
      <span class="profile-value">${site.postcode || '—'}</span>
    </div>
    <div class="profile-field">
      <span class="profile-label">Delivery instructions</span>
      <span class="profile-value">${site.deliveryInstructions || '—'}</span>
    </div>
    ${site.status === 'archived'
      ? `<p class="hint small-hint">Archived ${timeAgo(site.archivedAt)} by ${site.archivedById ? resolveDisplayName(site.archivedById) : 'the owner'}.</p>`
      : ''}
    <div class="owner-actions">
      <button class="btn btn-secondary" id="site-edit-btn">Edit</button>
      ${site.status === 'active'
        ? `<button class="btn btn-secondary" id="site-archive-btn">Archive site</button>`
        : `<button class="btn btn-primary" id="site-restore-btn">Restore site</button>`}
    </div>
  `;
}

function renderMembers(site) {
  const communityId = site.communityId;
  const members = approvedMembers(communityId);
  if (members.length === 0) {
    return '<p class="empty-hint">No approved community members yet.</p>';
  }
  return members.map(userId => {
    const displayName = resolveDisplayName(userId);
    const assigned = isSiteMember(site.id, userId);
    return `
      <div class="order-card">
        <div class="request-header">
          <div class="requester-badge" title="${displayName}">
            <span class="requester-avatar">${getInitials(displayName)}</span>
            <span class="requester-name">${displayName}</span>
          </div>
          <div class="order-card-main">
            <strong>${assigned ? 'Assigned to this site' : 'Not assigned'}</strong>
          </div>
        </div>
        <div class="owner-actions">
          ${assigned
            ? `<button class="btn btn-secondary" data-member-action="remove" data-member-id="${userId}">Remove from site</button>`
            : `<button class="btn btn-primary" data-member-action="add" data-member-id="${userId}">Add to site</button>`}
        </div>
      </div>
    `;
  }).join('');
}

function renderOrders(site) {
  const orders = latestOrders
    .filter(o => o.siteId === site.id)
    .sort((a, b) => b.createdAt - a.createdAt);

  if (orders.length === 0) {
    return '<p class="empty-hint">No orders for this site yet.</p>';
  }

  return orders.map(o => `
    <div class="order-card status-${o.status}" data-order-id="${o.id}">
      <div class="order-card-main">
        <strong>${o.productName}${o.variant ? ` (${o.variant})` : ''}</strong>
        <span>${o.quantity} × ${o.unit}${o.totalPrice != null ? ` &middot; ${formatPrice(o.totalPrice)}` : ''} &middot; requested by ${o.requestedBy || 'Unknown'}</span>
      </div>
      <span class="status-badge status-${o.status}">${STATUS_LABELS[o.status] || o.status}</span>
    </div>
  `).join('');
}

function renderDetail() {
  const site = getSite(selectedSiteId);
  if (!site) {
    showList();
    return;
  }

  detailEl.innerHTML = `
    <h1>${site.name}${site.status === 'archived' ? ' <span class="status-badge status-rejected">Archived</span>' : ''}</h1>
    ${renderSiteInfo(site)}
    <h2>Employees</h2>
    <div class="orders-list">${renderMembers(site)}</div>
    <h2>Orders</h2>
    <div class="orders-list">${renderOrders(site)}</div>
  `;

  wireDetailActions(site);
}

function wireDetailActions(site) {
  const editBtn = document.getElementById('site-edit-btn');
  if (editBtn) {
    editBtn.addEventListener('click', () => {
      editingSite = true;
      render();
    });
  }

  const archiveBtn = document.getElementById('site-archive-btn');
  if (archiveBtn) {
    archiveBtn.addEventListener('click', async () => {
      archiveBtn.disabled = true;
      const result = await archiveSite(site.id, currentActorId());
      if (!result.ok) {
        archiveBtn.disabled = false;
        alert(result.error);
      } else {
        render();
      }
    });
  }

  const restoreBtn = document.getElementById('site-restore-btn');
  if (restoreBtn) {
    restoreBtn.addEventListener('click', async () => {
      restoreBtn.disabled = true;
      const result = await restoreSite(site.id, currentActorId());
      if (!result.ok) {
        restoreBtn.disabled = false;
        alert(result.error);
      } else {
        render();
      }
    });
  }

  const cancelBtn = document.getElementById('site-edit-cancel-btn');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      editingSite = false;
      render();
    });
  }

  const saveBtn = document.getElementById('site-edit-save-btn');
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      const result = await updateSite(site.id, {
        name: document.getElementById('site-edit-name-input').value,
        address: document.getElementById('site-edit-address-input').value,
        postcode: document.getElementById('site-edit-postcode-input').value,
        deliveryInstructions: document.getElementById('site-edit-instructions-input').value,
      }, currentActorId());
      if (!result.ok) {
        saveBtn.disabled = false;
        const statusEl = document.getElementById('site-edit-status');
        statusEl.textContent = result.error;
        statusEl.className = 'form-status error';
        return;
      }
      editingSite = false;
      render();
    });
  }

  detailEl.querySelectorAll('[data-member-action]').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const userId = btn.dataset.memberId;
      const result = btn.dataset.memberAction === 'add'
        ? await addSiteMember(site.id, userId, currentActorId())
        : await removeSiteMember(site.id, userId, currentActorId());
      if (!result.ok) {
        btn.disabled = false;
        alert(result.error);
      } else {
        render();
      }
    });
  });
}

// Phase 8E: an optional siteId (from the owner dashboard's Sites summary,
// see main.js's sitestock:show-sites handler) opens straight into that
// site's existing detail view instead of the default list — same
// deep-link-on-entry pattern owner.js/buyer.js already use for orders. A
// stale/foreign id (getSite returns nothing, or it belongs to a different
// community) just falls through to the normal list, never a broken screen.
export function refreshSitesView(siteId = null) {
  activeTab = 'active';
  tabsEl.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.sitesTab === 'active'));
  const communityId = getActiveCommunityId();
  const target = siteId && getSite(siteId);
  if (target && target.communityId === communityId) {
    showDetail(siteId);
  } else {
    showList();
  }
}

subscribe(orders => {
  latestOrders = orders;
  render();
});

subscribeSites(render);
subscribeCommunities(render);
