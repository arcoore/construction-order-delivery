import './authView.js';
import { refreshCommunitiesView } from './communityView.js';
import { refreshWorkerView } from './site.js';
import { refreshOwnerView } from './owner.js';
import { refreshDriverView } from './driver.js';
import { refreshBuyerView } from './buyer.js';
import { refreshSitesView } from './sitesView.js';
import { isAuthenticated, getLoggedInAccount, logout as authLogout, authReady } from './auth.js';
import { getInitials, timeAgo } from './data.js';
import { getCurrentUserId, getCurrentDisplayName, subscribeIdentity, loadAllProfiles } from './identity.js';
import {
  getActiveCommunityId, getActiveCommunity,
  isApprovedMember, isOwner, setActiveCommunityId, membershipStatus, myCommunities,
  getActiveRole, setActiveRole, eligibleRoles, resolveEntryRole, subscribeCommunities,
  getCommunities, findUnseenGrantFor, markGrantSeen,
  buyerRequestStatus, requestBuyerRole, refreshCommunityCache,
} from './community.js';
import {
  subscribeNotifications, getNotificationsFor, getUnreadCount,
  markRead, markUnread, markAllRead, getPreferences, savePreferences,
  refreshNotificationCache,
} from './notifications.js';
import { canAccessSite, refreshSitesCache } from './sites.js';
import { refreshOrderCache } from './orderLifecycle.js';
import { refreshSupplierCache } from './suppliers.js';
import { refreshProductsCache } from './products.js';
import { startRealtimeForSession, stopRealtime } from './realtime.js';

// Phase 8B/8C: identity/company/site/order data is now Supabase-backed and
// shared across devices, but there's no Realtime subscription yet
// (deliberately deferred — see CLAUDE.md) — freshness comes from explicit
// refetch-on-write (community.js/sites.js/orderLifecycle.js's own writers),
// refetch-on-view-entry (this helper, called from the routing functions
// below that actually render community/site/order-dependent content), and
// refetch-on-window-focus (wired at the bottom of this file). None of this
// is the security boundary — RLS/the RPC functions are — so a failed/slow
// refresh here degrades to "briefly stale UI," never to a false permission
// grant or a lifecycle action succeeding when it shouldn't.
async function refreshDataCaches() {
  try {
    await Promise.all([refreshCommunityCache(), refreshSitesCache(), refreshOrderCache(), refreshNotificationCache(), refreshSupplierCache(), refreshProductsCache()]);
  } catch (err) {
    console.error('SiteStock: failed to refresh community/site/order/notification/supplier/product data', err);
  }
}

const bootstrapLoadingView = document.getElementById('bootstrap-loading');
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
  site_member_added: '📍',
  site_member_removed: '➖',
  site_archived: '🗄️',
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

async function showCommunitiesView() {
  showOnly(communitiesView);
  sessionBar.hidden = true;
  communityIndicator.textContent = 'Orders & Deliveries';
  updateTopRightPills();
  await refreshDataCaches();
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

async function showProfile() {
  await refreshDataCaches();

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
        <span class="profile-label">Email</span>
        <span class="profile-value">${account.email}</span>
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
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      await requestBuyerRole(btn.dataset.requestBuyer, userId);
      showProfile();
    });
  });

  showOnly(profileView);
  sessionBar.hidden = true;
  updateTopRightPills();
}

async function showRoleSelect() {
  await refreshDataCaches();

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

async function showRoleView() {
  await refreshDataCaches();

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

  communityIndicator.textContent = `${community.name} — ${displayName}`;
  sessionBar.hidden = false;
  // Phase 8E fix: this used to hide "Switch role" whenever the account had
  // a defaultRole — since every real account now has one (guest mode is
  // gone), that hid it for 100% of accounts, regardless of whether they
  // actually had more than one legitimate role to switch to. The correct
  // condition is simply "is there anything else to switch to."
  menuSwitchRoleBtn.hidden = roles.length <= 1;
  sessionLabel.textContent = `Logged in as ${ROLE_META[role].label}`;
  communityCircleBtn.textContent = getInitials(community.name);
  updateTopRightPills();

  if (role === 'worker') {
    showOnly(workerView);
    refreshWorkerView();
    highlightOrderIfPending();
  } else if (role === 'owner') {
    showOnly(ownerView);
    refreshOwnerView(pendingNotifOrderId);
    pendingNotifOrderId = null;
  } else if (role === 'driver') {
    showOnly(driverView);
    refreshDriverView();
    highlightOrderIfPending();
  } else if (role === 'buyer') {
    showOnly(buyerView);
    // Awaited (unlike the other three roles' refresh calls) because
    // refreshBuyerView is itself async since Phase 8C — it awaits
    // releaseHoldIfAny(), a real abandonPurchase RPC, before it's safe to
    // treat the Buyer view as actually refreshed.
    await refreshBuyerView(pendingNotifOrderId);
    pendingNotifOrderId = null;
  }
}

// Sites is reached only from inside an active owner session (the pill
// itself is only ever visible when hasActiveOwnerSession() is true), so
// this deliberately doesn't re-derive community/role chrome the way
// showRoleView does — it just swaps which section is visible and keeps the
// existing session bar.
async function showSitesView(siteId = null) {
  showOnly(sitesView);
  updateTopRightPills();
  await refreshDataCaches();
  refreshSitesView(siteId);
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
async function enterCommunityFlow() {
  await refreshDataCaches();

  const community = getActiveCommunity();
  const userId = getCurrentUserId();
  if (!community || !isApprovedMember(community.id, userId)) {
    setActiveCommunityId(null);
    showCommunityPicker();
    return;
  }

  // resolveEntryRole itself now handles a missing/non-matching preferred
  // role safely (returns null), so there's no separate "no defaultRole"
  // branch needed here — every real account has one anyway (guest mode is
  // gone), and the defensive fallback for the rare account that somehow
  // doesn't is exactly the same "null -> show the picker" path.
  const account = getLoggedInAccount();
  const role = resolveEntryRole(community.id, userId, account && account.defaultRole);
  if (role) {
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

// Phase 8E — the owner dashboard's Sites summary card dispatches this
// (rather than importing showSitesView directly) to avoid owner.js needing
// to import main.js, matching the existing cross-module navigation pattern
// already used for sitestock:show-profile / sitestock:go-to-auth.
window.addEventListener('sitestock:show-sites', e => {
  showSitesView(e.detail && e.detail.siteId ? e.detail.siteId : null);
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
  setActiveRole(null);
  // Phase 8D.2 — starts (or restarts, idempotently) Realtime for whichever
  // account just logged in. Safe even though community/order/notification
  // cache refreshes triggered by the auth transition may still be in
  // flight — every refreshXCache() this could race is itself a full,
  // idempotent replace, so "channel opens slightly before/after the first
  // cache load resolves" has no bad outcome either way.
  startRealtimeForSession();
  routeFromTop();
});

window.addEventListener('sitestock:logout', async () => {
  // Phase 8D.2 — stop BEFORE clearing session state, not after: this is
  // what guarantees no in-flight event from the outgoing account's channels
  // can still be processed once the auth transition below starts clearing
  // caches out from under it.
  stopRealtime();
  setActiveCommunityId(null);
  notifPanel.hidden = true;
  notifPrefsModal.hidden = true;
  // Awaited so the Supabase session is actually cleared (and the reactive
  // community/site cache refresh they trigger has fired) before routing —
  // avoids a flash of the previous account's data on the auth screen.
  await authLogout();
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
    return;
  }
  // Phase 8D.2 — live permission revalidation. This callback already fires
  // on every community-cache change regardless of cause (a same-tab write,
  // window-focus refresh, or — new this phase — a Realtime-triggered
  // refreshCommunityCache()/refreshSitesCache()), so the only new thing
  // here is the check itself, not a new trigger. Never treat a Realtime
  // event as proof of anything: by the time this callback runs, the cache
  // has already been authoritatively refetched under RLS, so
  // eligibleRoles() here reflects real, current, server-checked state —
  // exactly what a fresh page load would compute, just running earlier
  // than the user's next navigation would have surfaced it. Mirrors
  // navigateToNotification's existing "a target is a wish, never an
  // authority" fallback shape below, just triggered by a live cache change
  // instead of a notification click.
  const role = getActiveRole();
  if (role && !eligibleRoles(community.id, userId).includes(role)) {
    setActiveRole(null);
    showRoleSelect();
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
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const id = btn.dataset.notifToggle;
      const n = getNotificationsFor(getCurrentUserId()).find(x => x.id === id);
      if (!n) return;
      if (n.read) await markUnread(id); else await markRead(id);
    });
  });
}

async function openNotification(id) {
  const n = getNotificationsFor(getCurrentUserId()).find(x => x.id === id);
  if (!n) return;
  await markRead(id);
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
    // Site-scoped notifications carry a siteId that must still resolve to
    // real, current access — a stale notification can point somewhere, it
    // can never grant getting there. Drivers are the one deliberate
    // exception: Phase 4A never gave them a site permission function at
    // all (any approved member can claim any purchased order regardless of
    // site membership), so canAccessSite doesn't apply to driver-routed
    // targets — applying it there would incorrectly deny access drivers
    // were always meant to have.
    const siteOk = !target.siteId || target.role === 'driver'
      || canAccessSite(target.siteId, communityId, userId);
    if (roles.includes(target.role) && siteOk) {
      pendingNotifOrderId = target.orderId || null;
      setActiveRole(target.role);
      showRoleView();
      return;
    }
  }

  // No longer eligible for whatever this pointed at (role/community
  // membership, or site access, changed since it was created) — never open
  // the protected content, just route them to wherever they legitimately
  // belong now.
  routeFromTop();
}

notifBellBtn.addEventListener('click', e => {
  e.stopPropagation();
  accountMenu.hidden = true;
  notifPanel.hidden = !notifPanel.hidden;
  if (!notifPanel.hidden) renderNotifList();
});

notifPanel.addEventListener('click', e => e.stopPropagation());

notifMarkAllBtn.addEventListener('click', async () => {
  await markAllRead(getCurrentUserId());
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

notifPrefsSaveBtn.addEventListener('click', async () => {
  const draft = prefsDraft;
  prefsDraft = null;
  notifPrefsModal.hidden = true;
  await savePreferences(getCurrentUserId(), draft);
});

notifPrefsCancelBtn.addEventListener('click', () => {
  prefsDraft = null;
  notifPrefsModal.hidden = true;
});

// --- Phase 8B bootstrap ------------------------------------------------
// Explicit async gate: nothing routes until the real Supabase session has
// been restored AND the community/site caches have loaded at least once —
// see this file's refreshDataCaches() header and CLAUDE.md's Phase 8B
// section. #bootstrap-loading (active by default in index.html) covers the
// screen the whole time so nothing ever renders a role view off an empty
// cache, and no stale pre-login screen flashes before the real route is
// known.
async function bootstrap() {
  await authReady;
  await Promise.all([loadAllProfiles(), refreshDataCaches()]);
  // Phase 8D.2 — covers session restore (a page load with an existing
  // Supabase session already in localStorage), which never fires
  // 'sitestock:logged-in' — that event only exists for the login FORM's own
  // success path. startRealtimeForSession() itself no-ops if there's no
  // authenticated user, so this is safe to call unconditionally here too.
  startRealtimeForSession();
  bootstrapLoadingView.classList.remove('active');
  routeFromTop();
}

// Lightweight freshness mechanism, kept as a fallback even after Phase
// 8D.2 added Realtime (see CLAUDE.md's Phase 8D.2 section) — Realtime
// itself reconnects and re-refreshes on its own after a dropped
// connection, but a focus-triggered refresh is still the thing that
// recovers correctness if the websocket never reconnects at all (a real
// possibility: corporate proxies, restrictive networks, browser
// extensions). Re-pulls community/site/order/notification data whenever
// the tab regains focus, so switching back after changes happened
// elsewhere doesn't leave a badly stale cache sitting around indefinitely.
// This does not itself force a re-render of every open view — see
// refreshDataCaches()'s header for why that's an accepted, documented
// limitation for owner/buyer/driver/site.js specifically.
window.addEventListener('focus', () => {
  if (isAuthenticated()) refreshDataCaches();
});

bootstrap();
