import { getInitials, formatPrice, timeAgo, escapeHtml } from "./data.js";
import { subscribe } from './orderLifecycle.js';
import { itemsShortSummary } from './orderStatus.js';
import {
  subscribeSites, getSites, getSite, createSite, updateSite,
  archiveSite, changeSiteStatus, deleteSite, getSiteMembers, isSiteMember, addSiteMember, addSiteMembers, removeSiteMember,
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
const createStartDateInput = document.getElementById('site-start-date-input');
const createEndDateInput = document.getElementById('site-end-date-input');
const createContactNameInput = document.getElementById('site-contact-name-input');
const createContactPhoneInput = document.getElementById('site-contact-phone-input');
const createAccessNotesInput = document.getElementById('site-access-notes-input');
const createBudgetInput = document.getElementById('site-budget-input');
const createBtn = document.getElementById('create-site-btn');
const createStatusEl = document.getElementById('create-site-status');
const detailPanel = document.getElementById('site-detail-panel');
const detailEl = document.getElementById('site-detail');
const detailBackBtn = document.getElementById('site-detail-back-btn');

let activeTab = 'active';
let selectedSiteId = null;
let editingSite = false;
let latestOrders = [];
// Bulk-assign checkbox selection state, reset whenever the detail view is
// (re-)entered for a site - see showDetail below.
let bulkSelectedMemberIds = new Set();

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
  bulkSelectedMemberIds = new Set();
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
      projectStartDate: createStartDateInput.value,
      projectEndDate: createEndDateInput.value,
      siteContactName: createContactNameInput.value,
      siteContactPhone: createContactPhoneInput.value,
      accessNotes: createAccessNotesInput.value,
      monthlyBudget: createBudgetInput.value,
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
    createStartDateInput.value = '';
    createEndDateInput.value = '';
    createContactNameInput.value = '';
    createContactPhoneInput.value = '';
    createAccessNotesInput.value = '';
    createBudgetInput.value = '';
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
    const emptyMsg = {
      active: 'No sites yet - create one above.',
      paused: 'No paused sites.',
      completed: 'No completed sites.',
      archived: 'No archived sites.',
    }[activeTab] || 'Nothing here.';
    listEl.innerHTML = `<p class="empty-hint">${emptyMsg}</p>`;
    return;
  }

  listEl.innerHTML = sites.map(s => {
    const { memberCount, openCount } = siteSummary(s);
    return `
      <button type="button" class="result-card" data-site-id="${s.id}">
        <span class="result-name">${escapeHtml(s.name)}</span>
        <span class="result-meta">${escapeHtml([s.address, s.postcode].filter(Boolean).join(' · ') || 'No address on file')}</span>
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
  purchased: 'Purchased - waiting for a driver',
  claimed: 'Driver assigned',
  collected: 'Collected - in transit',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

const SITE_STATUS_LABEL = {
  active: 'Active',
  paused: 'Paused',
  completed: 'Completed',
  archived: 'Archived',
};

// Only 'active' accepts new orders (see sites.js's changeSiteStatus).
// Buttons offer the sensible next moves from each status.
function siteStatusButtons(site) {
  const btn = (status, label, primary) =>
    `<button class="btn btn-${primary ? 'primary' : 'secondary'}" data-site-status="${status}">${label}</button>`;
  if (site.status === 'active') {
    return btn('paused', 'Pause') + btn('completed', 'Mark complete') + btn('archived', 'Archive');
  }
  if (site.status === 'paused') {
    return btn('active', 'Reactivate', true) + btn('completed', 'Mark complete') + btn('archived', 'Archive');
  }
  if (site.status === 'completed') {
    return btn('active', 'Reopen', true) + btn('archived', 'Archive');
  }
  return btn('active', 'Restore', true);
}

// Client-side mirror of the SQL _site_committed_spend helper (migration
// 0033) - current calendar month, orders that still count (not
// rejected/cancelled). Display only; the real enforcement is the DB trigger.
function siteMonthSpend(siteId) {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  return latestOrders
    .filter(o => o.siteId === siteId
      && !['rejected', 'cancelled'].includes(o.status)
      && new Date(o.createdAt).getFullYear() === y
      && new Date(o.createdAt).getMonth() === m)
    .reduce((sum, o) => sum + (o.totalPrice || 0), 0);
}

function renderSiteInfo(site) {
  if (editingSite) {
    return `
      <div class="reject-form">
        <label class="field-label" for="site-edit-name-input">Site name</label>
        <input type="text" id="site-edit-name-input" class="text-input" value="${escapeHtml(site.name)}" />
        <label class="field-label" for="site-edit-address-input">Address</label>
        <input type="text" id="site-edit-address-input" class="text-input" value="${escapeHtml(site.address)}" />
        <label class="field-label" for="site-edit-postcode-input">Postcode</label>
        <input type="text" id="site-edit-postcode-input" class="text-input" value="${escapeHtml(site.postcode)}" />
        <label class="field-label" for="site-edit-instructions-input">Delivery instructions</label>
        <input type="text" id="site-edit-instructions-input" class="text-input" value="${escapeHtml(site.deliveryInstructions || "")}" />
        <label class="field-label" for="site-edit-start-date-input">Project start date</label>
        <input type="date" id="site-edit-start-date-input" class="text-input" value="${site.projectStartDate || ''}" />
        <label class="field-label" for="site-edit-end-date-input">Project end date</label>
        <input type="date" id="site-edit-end-date-input" class="text-input" value="${site.projectEndDate || ''}" />
        <label class="field-label" for="site-edit-contact-name-input">Site contact</label>
        <input type="text" id="site-edit-contact-name-input" class="text-input" value="${escapeHtml(site.siteContactName || "")}" />
        <label class="field-label" for="site-edit-contact-phone-input">Contact phone</label>
        <input type="tel" id="site-edit-contact-phone-input" class="text-input" value="${escapeHtml(site.siteContactPhone || "")}" />
        <label class="field-label" for="site-edit-access-notes-input">Access notes</label>
        <input type="text" id="site-edit-access-notes-input" class="text-input" value="${escapeHtml(site.accessNotes || "")}" />
        <label class="field-label" for="site-edit-budget-input">Monthly budget £ (blank = none)</label>
        <input type="number" id="site-edit-budget-input" class="text-input" min="0" step="1" value="${site.monthlyBudget ?? ''}" />
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
      <span class="profile-value">${escapeHtml(site.address || " - ")}</span>
    </div>
    <div class="profile-field">
      <span class="profile-label">Postcode</span>
      <span class="profile-value">${escapeHtml(site.postcode || " - ")}</span>
    </div>
    <div class="profile-field">
      <span class="profile-label">Delivery instructions</span>
      <span class="profile-value">${escapeHtml(site.deliveryInstructions || " - ")}</span>
    </div>
    ${(site.projectStartDate || site.projectEndDate) ? `
    <div class="profile-field">
      <span class="profile-label">Project dates</span>
      <span class="profile-value">${site.projectStartDate || 'Not set'} - ${site.projectEndDate || 'ongoing'}</span>
    </div>` : ''}
    ${site.siteContactName || site.siteContactPhone ? `
    <div class="profile-field">
      <span class="profile-label">Site contact</span>
      <span class="profile-value">${escapeHtml([site.siteContactName, site.siteContactPhone].filter(Boolean).join(" · "))}</span>
    </div>` : ''}
    ${site.accessNotes ? `
    <div class="profile-field">
      <span class="profile-label">Access notes</span>
      <span class="profile-value">${escapeHtml(site.accessNotes)}</span>
    </div>` : ''}
    ${site.monthlyBudget != null ? `
    <div class="profile-field">
      <span class="profile-label">Monthly budget</span>
      <span class="profile-value">${formatPrice(siteMonthSpend(site.id))} of ${formatPrice(site.monthlyBudget)} committed this month${siteMonthSpend(site.id) >= site.monthlyBudget ? ' - at limit' : ''}</span>
    </div>` : ''}
    <div class="profile-field">
      <span class="profile-label">Status</span>
      <span class="profile-value">${SITE_STATUS_LABEL[site.status] || site.status}${site.status === 'archived' && site.archivedAt ? ` - ${timeAgo(site.archivedAt)} by ${site.archivedById ? escapeHtml(resolveDisplayName(site.archivedById)) : "the owner"}` : ''}</span>
    </div>
    <div class="owner-actions">
      <button class="btn btn-secondary" id="site-edit-btn">Edit</button>
      ${siteStatusButtons(site)}
    </div>
    ${latestOrders.some(o => o.siteId === site.id) ? '' : `
      <p class="hint small-hint">This site has no orders - it can be deleted permanently instead of archived.</p>
      <button type="button" class="link-btn link-btn-danger" id="site-delete-btn">Delete this site permanently</button>`}
  `;
}

function renderMembers(site) {
  const communityId = site.communityId;
  const members = approvedMembers(communityId);
  if (members.length === 0) {
    return '<p class="empty-hint">No approved company members yet.</p>';
  }
  const unassignedCount = members.filter(userId => !isSiteMember(site.id, userId)).length;

  const bulkBar = unassignedCount > 0 ? `
    <div class="owner-actions" id="bulk-assign-bar">
      <button class="btn btn-primary" id="bulk-assign-btn" ${bulkSelectedMemberIds.size === 0 ? 'disabled' : ''}>
        Assign ${bulkSelectedMemberIds.size || ''} selected
      </button>
      <p id="bulk-assign-status" class="form-status"></p>
    </div>
  ` : '';

  const rows = members.map(userId => {
    const displayName = resolveDisplayName(userId);
    const assigned = isSiteMember(site.id, userId);
    return `
      <div class="order-card">
        <div class="request-header">
          ${!assigned ? `<input type="checkbox" class="bulk-assign-checkbox" data-bulk-member-id="${userId}" ${bulkSelectedMemberIds.has(userId) ? 'checked' : ''} aria-label="Select ${escapeHtml(displayName)} for bulk assignment" />` : ''}
          <div class="requester-badge" title="${escapeHtml(displayName)}">
            <span class="requester-avatar">${getInitials(displayName)}</span>
            <span class="requester-name">${escapeHtml(displayName)}</span>
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

  return bulkBar + rows;
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
        <strong>${itemsShortSummary(o)}</strong>
        <span>${o.totalPrice != null ? `${formatPrice(o.totalPrice)} &middot; ` : ''}requested by ${escapeHtml(o.requestedBy || "Unknown")}</span>
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
    <h1>${escapeHtml(site.name)}${site.status !== 'active' ? ` <span class="status-badge status-rejected">${SITE_STATUS_LABEL[site.status] || site.status}</span>` : ''}</h1>
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

  const deleteBtn = document.getElementById('site-delete-btn');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', async () => {
      if (!window.confirm(`Permanently delete "${site.name}"? This cannot be undone.`)) return;
      deleteBtn.disabled = true;
      const result = await deleteSite(site.id, currentActorId());
      if (!result.ok) { deleteBtn.disabled = false; alert(result.error); return; }
      showList();
    });
  }

  detailEl.querySelectorAll('[data-site-status]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const target = btn.dataset.siteStatus;
      btn.disabled = true;
      // archiveSite also fires the site_archived notification to members;
      // every other transition is a plain status change.
      const result = target === 'archived'
        ? await archiveSite(site.id, currentActorId())
        : await changeSiteStatus(site.id, target, currentActorId());
      if (!result.ok) {
        btn.disabled = false;
        alert(result.error);
      } else {
        render();
      }
    });
  });

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
        projectStartDate: document.getElementById('site-edit-start-date-input').value,
        projectEndDate: document.getElementById('site-edit-end-date-input').value,
        siteContactName: document.getElementById('site-edit-contact-name-input').value,
        siteContactPhone: document.getElementById('site-edit-contact-phone-input').value,
        accessNotes: document.getElementById('site-edit-access-notes-input').value,
        monthlyBudget: document.getElementById('site-edit-budget-input').value,
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
        bulkSelectedMemberIds.delete(userId);
        render();
      }
    });
  });

  detailEl.querySelectorAll('.bulk-assign-checkbox').forEach(cb => {
    cb.addEventListener('change', () => {
      const userId = cb.dataset.bulkMemberId;
      if (cb.checked) bulkSelectedMemberIds.add(userId);
      else bulkSelectedMemberIds.delete(userId);
      render();
    });
  });

  const bulkAssignBtn = document.getElementById('bulk-assign-btn');
  if (bulkAssignBtn) {
    bulkAssignBtn.addEventListener('click', async () => {
      bulkAssignBtn.disabled = true;
      const statusEl = document.getElementById('bulk-assign-status');
      const result = await addSiteMembers(site.id, Array.from(bulkSelectedMemberIds), currentActorId());
      if (!result.ok) {
        bulkAssignBtn.disabled = false;
        if (statusEl) {
          statusEl.textContent = result.error;
          statusEl.className = 'form-status error';
        }
        return;
      }
      bulkSelectedMemberIds = new Set();
      render();
    });
  }
}

// Phase 8E: an optional siteId (from the owner dashboard's Sites summary,
// see main.js's sitestock:show-sites handler) opens straight into that
// site's existing detail view instead of the default list - same
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
