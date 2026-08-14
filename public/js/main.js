import './authView.js';
import { refreshCommunitiesView } from './communityView.js';
import { refreshWorkerView } from './site.js';
import { refreshOwnerView } from './owner.js';
import { refreshDriverView } from './driver.js';
import { refreshBuyerView } from './buyer.js';
import { refreshSitesView } from './sitesView.js';
import { isAuthenticated, getLoggedInAccount, logout as authLogout } from './auth.js';
import { getInitials, timeAgo } from './data.js';
import { getCurrentUserId, getCurrentDisplayName, isGuest, newGuestIdentity, subscribeIdentity } from './identity.js';
import {
  getActiveCommunityId, getActiveCommunity,
  isApprovedMember, isOwner, setActiveCommunityId, membershipStatus, myCommunities,
  getActiveRole, setActiveRole, eligibleRoles, resolveEntryRole, subscribeCommunities,
  getCommunities, findUnseenGrantFor, markGrantSeen,
  buyerRequestStatus, requestBuyerRole,
} from './community.js';
import {
  subscribeNotifications, getNotificationsFor, getUnreadCount,
  markRead, markUnread, markAllRead, getPreferences, savePreferences,
} from './notifications.js';

const authView = document.getElementById('auth-view');
const communityView = document.getElementById('community-view');
const communitiesView = document.getElementById('communities-view');
const profileView = document.getElementById('profile-view');
const roleSelectView = document.getElementById('role-select-view');
const workerView = document.getElementById('worker-view');
const ownerView = document.getElementById('owner-view');
const driverView = document.getElementById('driver-view');
const buyerView = document.getElementById('buyer-view');
const sitesView = document.getElementById('sites-view');
const sessionBar = document.getElementById('session-bar');
const sessionLabel = document.getElementById('session-label');
const communityIndicator = document.getElementById('community-indicator');
const communitiesPillBtn = document.getElementById('communities-pill-btn');
const sitesPillBtn = document.getElementById('sites-pill-btn');
const sitesBackBtn = document.getElementById('sites-back-btn');
const communitiesBackBtn = document.getElementById('communities-back-btn');
const goToCommunitiesBtn = document.getElementById('go-to-communities-btn');
const profilePillBtn = document.getElementById('profile-pill-btn');
const profileBackBtn = document.getElementById('profile-back-btn');
const profileDetails = document.getElementById('profile-details');
const communityCircleBtn = document.getElementById('community-circle-btn');
const accountCircleBtn = document.getElementById('account-circle-btn');
const accountMenu = document.getElementById('account-menu');
const menuSwitchRoleBtn = document.getElementById('menu-switch-role-btn');
const menuLogoutBtn = document.getElementById('menu-logout-btn');
const roleSelectName = document.getElementById('role-select-name');
const roleSelectCommunityName = document.getElementById('role-select-community-name');
const roleSelectList = document.getElementById('role-select-list');
const ownerUpgradeModal = document.getElementById('owner-upgrade-modal');
const ownerUpgradeMessage = document.getElementById('owner-upgrade-message');
const ownerUpgradeOkBtn = document.getElementById('owner-upgrade-ok-btn');
const notifWrap = document.getElementById('notif-wrap');
const notifBellBtn = document.getElementById('notif-bell-btn');
const notifBadge = document.getElementById('notif-badge');
const notifPanel = document.getElementById('notif-panel');
const notifList = document.getElementById('notif-list');
const notifMarkAllBtn = document.getElementById('notif-mark-all-btn');
const notifPrefsBtn = document.getElementById('notif-prefs-btn');
const notifPrefsModal = document.getElementById('notif-prefs-modal');
const prefOrderUpdates = document.getElementById('pref-order-updates');
const prefApprovalUpdates = document.getElementById('pref-approval-updates');
const prefDeliveryUpdates = document.getElementById('pref-delivery-updates');
const prefRoleUpdates = document.getElementById('pref-role-updates');
const prefDeliveryAvailable = document.getElementById('pref-delivery-available');
const prefDeliveryClaimed = document.getElementById('pref-delivery-claimed');
const prefDeliveryCollected = document.getElementById('pref-delivery-collected');
const notifPrefsSaveBtn = document.getElementById('notif-prefs-save-btn');
const notifPrefsCancelBtn = document.getElementById('notif-prefs-cancel-btn');

const NOTIF_ICONS = {
  order_awaiting_approval: '📝',
  order_rejected: '🚫',
  approval_reverted: '↩️',
  order_ready_for_purchase: '💳',
  delivery_available: '🚚',
  delivery_claimed: '🚚',
  delivery_cancelled: '⚠️',
  delivery_collected: '📦',
  order_delivered: '🏁',
  buyer_access_requested: '🛒',
  buyer_access_granted: '✅',
  buyer_access_rejected: '🚫',
  buyer_access_revoked: '⛔',
};

const ALL_VIEWS = [authView, communityView, communitiesView, profileView, roleSelectView, workerView, ownerView, driverView, buyerView, sitesView];

const ROLE_META = {
  owner: { icon: '👑', label: 'Owner', desc: 'Approve worker requests and community join requests' },
  worker: { icon: '🧑‍🔧', label: 'Worker', desc: 'Search for materials and place order requests' },
  driver: { icon: '🚚', label: 'Driver', desc: 'Pick up approved orders and deliver them' },
  buyer: { icon: '🛒', label: 'Buyer', desc: 'Purchase approved orders and confirm the purchase' },
};

function showOnly(view) {
  ALL_VIEWS.forEach(v => v.classList.toggle('active', v === view));
}

// True whenever the current user actually owns the active community — a
// real permission check (isOwner), not "which role view happens to be on
// screen right now". This is what lets the Sites pill follow the owner
// around to Profile/Communities/Role-Select instead of only appearing on
// the dashboard itself, exactly like the Communities pill already does.
function hasActiveOwnerSession() {
  const communityId = getActiveCommunityId();
  return !!communityId && isOwner(communityId, getCurrentUserId());
}

function updateTopRightPills() {
  profilePillBtn.hidden = false;
  profilePillBtn.textContent = getLoggedInAccount() ? 'Show profile' : 'Log in';
  communitiesPillBtn.hidden = false;
  notifWrap.hidden = false;
  sitesPillBtn.hidden = !hasActiveOwnerSession();
}

function showAuth() {
  showOnly(authView);
  sessionBar.hidden = true;
  profilePillBtn.hidden = true;
  communitiesPillBtn.hidden = true;
  sitesPillBtn.hidden = true;
  notifWrap.hidden = true;
  notifPanel.hidden = true;
  communityIndicator.textContent = 'Orders & Deliveries';
}

function showCommunityPicker() {
  showOnly(communityView);
  sessionBar.hidden = true;
  communityIndicator.textContent = 'Orders & Deliveries';
  updateTopRightPills();
}

function showCommunitiesView() {
  showOnly(communitiesView);
  sessionBar.hidden = true;
  communityIndicator.textContent = 'Orders & Deliveries';
  updateTopRightPills();
  refreshCommunitiesView();
}

function renderBuyerBadge(membership) {
  if (membership.buyerStatus === 'granted') {
    return '<span class="status-badge status-granted">Buyer</span>';
  }
  if (membership.buyerStatus === 'pending') {
    return '<span class="status-badge status-pending">Buyer requested</span>';
  }
  return `<button type="button" class="link-btn" data-request-buyer="${membership.id}">Request buyer access</button>`;
}

function showProfile() {
  const account = getLoggedInAccount();
  const userId = getCurrentUserId();
  const displayName = getCurrentDisplayName();

  const memberships = myCommunities(userId).map(c => ({
    id: c.id,
    name: c.name,
    role: membershipStatus(c.id, userId) === 'owner' ? 'Owner' : 'Member',
    buyerStatus: buyerRequestStatus(c.id, userId),
  }));

  profileDetails.innerHTML = `
    <div class="profile-field">
      <span class="profile-label">Display name</span>
      <span class="profile-value">${displayName || '—'}</span>
    </div>
    ${account ? `
      <div class="profile-field">
        <span class="profile-label">Username</span>
        <span class="profile-value">${account.username}</span>
      </div>
      <div class="profile-field">
        <span class="profile-label">Account created</span>
        <span class="profile-value">${new Date(account.createdAt).toLocaleDateString()}</span>
      </div>
    ` : ''}
    <div class="profile-field">
      <span class="profile-label">Communities (${memberships.length})</span>
      <div class="profile-communities">
        ${memberships.length === 0
          ? '<span class="profile-value">Not in any communities yet</span>'
          : memberships.map(m => `
            <div class="profile-community-row">
              <strong>${m.name}</strong>
              <span class="status-badge status-pending">${m.role}</span>
              ${renderBuyerBadge(m)}
            </div>
          `).join('')}
      </div>
    </div>
    <button type="button" class="btn btn-secondary btn-block" id="profile-logout-btn">Log out</button>
  `;

  document.getElementById('profile-logout-btn').addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('sitestock:logout'));
  });

  profileDetails.querySelectorAll('[data-request-buyer]').forEach(btn => {
    btn.addEventListener('click', () => {
      requestBuyerRole(btn.dataset.requestBuyer, userId);
      showProfile();
    });
  });

  showOnly(profileView);
  sessionBar.hidden = true;
  updateTopRightPills();
}

function showRoleSelect() {
  const community = getActiveCommunity();
  const userId = getCurrentUserId();
  const displayName = getCurrentDisplayName();
  if (!community || !isApprovedMember(community.id, userId)) {
    setActiveCommunityId(null);
    showCommunityPicker();
    return;
  }

  roleSelectName.textContent = displayName;
  roleSelectCommunityName.textContent = community.name;

  const roles = eligibleRoles(community.id, userId);
  roleSelectList.innerHTML = roles.map(role => {
    const meta = ROLE_META[role];
    return `
      <button type="button" class="role-select-card" data-role="${role}">
        <span class="role-select-icon" aria-hidden="true">${meta.icon}</span>
        <span class="role-select-info">
          <strong>${meta.label}</strong>
          <span>${meta.desc}</span>
        </span>
        <span class="variant-option-arrow" aria-hidden="true">&rarr;</span>
      </button>
    `;
  }).join('');

  roleSelectList.querySelectorAll('[data-role]').forEach(btn => {
    btn.addEventListener('click', () => {
      setActiveRole(btn.dataset.role);
      showRoleView();
    });
  });

  showOnly(roleSelectView);
  sessionBar.hidden = false;
  menuSwitchRoleBtn.hidden = true;
  sessionLabel.textContent = 'Choosing a role…';
  communityIndicator.textContent = `${community.name} — ${displayName}`;
  communityCircleBtn.textContent = getInitials(community.name);
  updateTopRightPills();
}

function showRoleView() {
  const community = getActiveCommunity();
  const userId = getCurrentUserId();
  const displayName = getCurrentDisplayName();
  const role = getActiveRole();

  if (!community || !isApprovedMember(community.id, userId)) {
    setActiveCommunityId(null);
    showCommunityPicker();
    return;
  }

  const roles = eligibleRoles(community.id, userId);
  if (!role || !roles.includes(role)) {
    showRoleSelect();
    return;
  }

  const account = getLoggedInAccount();

  communityIndicator.textContent = `${community.name} — ${displayName}`;
  sessionBar.hidden = false;
  menuSwitchRoleBtn.hidden = !!(account && account.defaultRole);
  sessionLabel.textContent = `Logged in as ${ROLE_META[role].label}`;
  communityCircleBtn.textContent = getInitials(community.name);
  updateTopRightPills();

  if (role === 'worker') {
    showOnly(workerView);
    refreshWorkerView();
    highlightOrderIfPending();
  } else if (role === 'owner') {
    showOnly(ownerView);
    refreshOwnerView();
    highlightOrderIfPending();
  } else if (role === 'driver') {
    showOnly(driverView);
    refreshDriverView();
    highlightOrderIfPending();
  } else if (role === 'buyer') {
    showOnly(buyerView);
    refreshBuyerView(pendingNotifOrderId);
    pendingNotifOrderId = null;
  }
}

// Sites is reached only from inside an active owner session (the pill
// itself is only ever visible when hasActiveOwnerSession() is true), so
// this deliberately doesn't re-derive community/role chrome the way
// showRoleView does — it just swaps which section is visible and keeps the
// existing session bar.
function showSitesView() {
  showOnly(sitesView);
  updateTopRightPills();
  refreshSitesView();
}

// Set right before routing into a role-view from a notification click, so
// that view can scroll to and briefly highlight the specific order the
// notification was about — the three flat-list views (worker/owner/driver)
// don't have their own per-order navigation the way buyer.js's detail view
// does, so this is the shared fallback for all three.
let pendingNotifOrderId = null;

function highlightOrderIfPending() {
  if (!pendingNotifOrderId) return;
  const id = pendingNotifOrderId;
  pendingNotifOrderId = null;
  requestAnimationFrame(() => {
    const el = document.querySelector(`[data-order-id="${id}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('order-card-highlight');
    setTimeout(() => el.classList.remove('order-card-highlight'), 2000);
  });
}

// Resolves where someone lands in a community with no prompt when possible:
// their account already answered "worker/driver/owner" at signup, so we can
// go straight there (owner only ever applies if they actually are one).
// Falls back to the manual picker for skipped sessions / accounts made
// before this existed.
function enterCommunityFlow() {
  const community = getActiveCommunity();
  const userId = getCurrentUserId();
  if (!community || !isApprovedMember(community.id, userId)) {
    setActiveCommunityId(null);
    showCommunityPicker();
    return;
  }

  const account = getLoggedInAccount();
  if (account && account.defaultRole) {
    const role = resolveEntryRole(community.id, userId, account.defaultRole);
    setActiveRole(role);
    showRoleView();
  } else {
    showRoleSelect();
  }
}

function enterCommunityApp() {
  if (getActiveRole()) {
    showRoleView();
  } else {
    enterCommunityFlow();
  }
}

function routeFromTop() {
  if (!isAuthenticated()) {
    showAuth();
    return;
  }
  if (getActiveCommunityId()) {
    enterCommunityApp();
  } else {
    showCommunityPicker();
  }
}

let pendingGrantCommunityId = null;

function checkForNewOwnerGrant() {
  if (!isAuthenticated()) return;
  const grant = findUnseenGrantFor(getCurrentUserId());
  if (!grant) return;

  markGrantSeen(grant.id);
  const community = getCommunities().find(c => c.id === grant.communityId);
  pendingGrantCommunityId = grant.communityId;
  ownerUpgradeMessage.textContent = community
    ? `You now have owner-level access in "${community.name}".`
    : 'You now have owner-level access.';
  ownerUpgradeModal.hidden = false;
}

ownerUpgradeOkBtn.addEventListener('click', () => {
  ownerUpgradeModal.hidden = true;
  if (pendingGrantCommunityId && getActiveCommunityId() === pendingGrantCommunityId) {
    setActiveRole(null);
    enterCommunityFlow();
  }
  pendingGrantCommunityId = null;
});

profilePillBtn.addEventListener('click', () => {
  if (getLoggedInAccount()) {
    showProfile();
  } else {
    showAuth();
  }
});

profileBackBtn.addEventListener('click', () => {
  routeFromTop();
});

communitiesPillBtn.addEventListener('click', () => {
  showCommunitiesView();
});

sitesPillBtn.addEventListener('click', () => {
  showSitesView();
});

sitesBackBtn.addEventListener('click', () => {
  showRoleView();
});

communitiesBackBtn.addEventListener('click', () => {
  routeFromTop();
});

goToCommunitiesBtn.addEventListener('click', () => {
  showCommunitiesView();
});

communityCircleBtn.addEventListener('click', () => {
  accountMenu.hidden = true;
  setActiveCommunityId(null);
  showCommunityPicker();
});

accountCircleBtn.addEventListener('click', e => {
  e.stopPropagation();
  notifPanel.hidden = true;
  accountMenu.hidden = !accountMenu.hidden;
});

document.addEventListener('click', () => {
  accountMenu.hidden = true;
  notifPanel.hidden = true;
});

accountMenu.addEventListener('click', e => e.stopPropagation());

menuSwitchRoleBtn.addEventListener('click', () => {
  accountMenu.hidden = true;
  setActiveRole(null);
  showRoleSelect();
});

menuLogoutBtn.addEventListener('click', () => {
  accountMenu.hidden = true;
  window.dispatchEvent(new CustomEvent('sitestock:logout'));
});

window.addEventListener('sitestock:enter-community', () => {
  setActiveRole(null);
  enterCommunityFlow();
});

window.addEventListener('sitestock:logged-in', () => {
  routeFromTop();
});

window.addEventListener('sitestock:logout', () => {
  // Only rotate the guest id if a guest was the one logging out — logging
  // out of a real account shouldn't blow away an unrelated dormant guest
  // identity that was never itself compromised or signed out of.
  const wasGuest = isGuest();
  setActiveCommunityId(null);
  authLogout();
  if (wasGuest) newGuestIdentity();
  notifPanel.hidden = true;
  notifPrefsModal.hidden = true;
  showAuth();
});

window.addEventListener('sitestock:go-to-auth', () => showAuth());
window.addEventListener('sitestock:show-profile', () => showProfile());

subscribeIdentity(checkForNewOwnerGrant);

subscribeCommunities(() => {
  checkForNewOwnerGrant();
  if (!getActiveCommunityId()) return;
  const community = getActiveCommunity();
  const userId = getCurrentUserId();
  if (!community || !isApprovedMember(community.id, userId)) {
    showCommunityPicker();
  }
});

// --- Notification bell / panel ---------------------------------------

function renderNotifBell() {
  if (!isAuthenticated()) return;
  const unread = getUnreadCount(getCurrentUserId());
  notifBadge.hidden = unread === 0;
  notifBadge.textContent = unread > 99 ? '99+' : String(unread);
  if (!notifPanel.hidden) renderNotifList();
}

function renderNotifList() {
  const userId = getCurrentUserId();
  const notifs = getNotificationsFor(userId);
  if (notifs.length === 0) {
    notifList.innerHTML = '<p class="empty-hint">No notifications yet.</p>';
    return;
  }
  notifList.innerHTML = notifs.map(n => `
    <div class="notif-row${!n.read ? ' notif-row-unread' : ''}">
      <span class="notif-row-icon" aria-hidden="true">${NOTIF_ICONS[n.type] || '🔔'}</span>
      <button type="button" class="notif-row-body" data-notif-open="${n.id}">
        <strong>${n.title}</strong>
        <span>${n.message}</span>
        <span class="notif-row-time">${timeAgo(n.createdAt)}</span>
      </button>
      <button type="button" class="notif-row-toggle" data-notif-toggle="${n.id}" title="${n.read ? 'Mark as unread' : 'Mark as read'}">${n.read ? '○' : '●'}</button>
    </div>
  `).join('');

  notifList.querySelectorAll('[data-notif-open]').forEach(btn => {
    btn.addEventListener('click', () => openNotification(btn.dataset.notifOpen));
  });
  notifList.querySelectorAll('[data-notif-toggle]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id = btn.dataset.notifToggle;
      const n = getNotificationsFor(getCurrentUserId()).find(x => x.id === id);
      if (!n) return;
      if (n.read) markUnread(id); else markRead(id);
    });
  });
}

function openNotification(id) {
  const n = getNotificationsFor(getCurrentUserId()).find(x => x.id === id);
  if (!n) return;
  markRead(id);
  notifPanel.hidden = true;
  navigateToNotification(n);
}

// A notification's navigationTarget carries no authority of its own —
// permissions are always re-checked fresh here, exactly as they already are
// on every other navigation in this app. A notification can point
// somewhere; it can never grant access to get there.
function navigateToNotification(n) {
  const target = n.navigationTarget || {};
  const userId = getCurrentUserId();

  if (target.communityId && target.communityId !== getActiveCommunityId()) {
    setActiveCommunityId(target.communityId);
  }

  if (target.view === 'profile') {
    showProfile();
    return;
  }

  if (target.role) {
    const communityId = target.communityId || getActiveCommunityId();
    const roles = communityId ? eligibleRoles(communityId, userId) : [];
    if (roles.includes(target.role)) {
      pendingNotifOrderId = target.orderId || null;
      setActiveRole(target.role);
      showRoleView();
      return;
    }
  }

  // No longer eligible for whatever this pointed at (role/community
  // membership changed since it was created) — never open the protected
  // content, just route them to wherever they legitimately belong now.
  routeFromTop();
}

notifBellBtn.addEventListener('click', e => {
  e.stopPropagation();
  accountMenu.hidden = true;
  notifPanel.hidden = !notifPanel.hidden;
  if (!notifPanel.hidden) renderNotifList();
});

notifPanel.addEventListener('click', e => e.stopPropagation());

notifMarkAllBtn.addEventListener('click', () => {
  markAllRead(getCurrentUserId());
});

subscribeNotifications(renderNotifBell);
subscribeIdentity(renderNotifBell);

// --- Notification preferences -----------------------------------------

let prefsDraft = null;

function syncPrefsCheckboxes() {
  prefOrderUpdates.checked = prefsDraft.orderUpdates;
  prefApprovalUpdates.checked = prefsDraft.approvalUpdates;
  prefDeliveryUpdates.checked = prefsDraft.deliveryUpdates;
  prefRoleUpdates.checked = prefsDraft.roleUpdates;
  prefDeliveryAvailable.checked = prefsDraft.deliveryAvailableEnabled;
  prefDeliveryClaimed.checked = prefsDraft.deliveryClaimedEnabled;
  prefDeliveryCollected.checked = prefsDraft.deliveryCollectedEnabled;
}

notifPrefsBtn.addEventListener('click', () => {
  notifPanel.hidden = true;
  prefsDraft = { ...getPreferences(getCurrentUserId()) };
  syncPrefsCheckboxes();
  notifPrefsModal.hidden = false;
});

prefOrderUpdates.addEventListener('change', () => { prefsDraft.orderUpdates = prefOrderUpdates.checked; });
prefApprovalUpdates.addEventListener('change', () => { prefsDraft.approvalUpdates = prefApprovalUpdates.checked; });
prefDeliveryUpdates.addEventListener('change', () => { prefsDraft.deliveryUpdates = prefDeliveryUpdates.checked; });
prefRoleUpdates.addEventListener('change', () => { prefsDraft.roleUpdates = prefRoleUpdates.checked; });
prefDeliveryAvailable.addEventListener('change', () => { prefsDraft.deliveryAvailableEnabled = prefDeliveryAvailable.checked; });
prefDeliveryClaimed.addEventListener('change', () => { prefsDraft.deliveryClaimedEnabled = prefDeliveryClaimed.checked; });
prefDeliveryCollected.addEventListener('change', () => { prefsDraft.deliveryCollectedEnabled = prefDeliveryCollected.checked; });

notifPrefsSaveBtn.addEventListener('click', () => {
  savePreferences(getCurrentUserId(), prefsDraft);
  prefsDraft = null;
  notifPrefsModal.hidden = true;
});

notifPrefsCancelBtn.addEventListener('click', () => {
  prefsDraft = null;
  notifPrefsModal.hidden = true;
});

routeFromTop();
