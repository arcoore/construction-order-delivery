import './authView.js';
import { refreshCommunitiesView, applyPendingJoinIntent } from './communityView.js';
// The five role/screen modules (site/owner/driver/buyer/sitesView) are the
// bulk of this app's JS and any given user only ever needs one or two of
// them, so they're pulled in on first navigation via dynamic import()
// instead of at bootstrap - see loadView() and showRoleView() below. Their
// view-only shared deps (orderStatus/deadline/geo/orderThreadView/
// deliveryPhotosView) ride along in each module's own import subtree and so
// leave the initial load too.
import { isAuthenticated, getLoggedInAccount, logout as authLogout, authReady, inPasswordRecoveryContext, didJustConfirmEmail, isMfaChallengePending, getMfaEnabled, startMfaEnrollment, confirmMfaEnrollment, disableMfa, deleteAccount, requestEmailChange, updateDisplayName } from './auth.js';
import { getInitials, timeAgo, escapeHtml } from './data.js';
import { getCurrentUserId, getCurrentDisplayName, resolveDisplayName, subscribeIdentity, loadAllProfiles } from './identity.js';
import {
  getActiveCommunityId, getActiveCommunity,
  isApprovedMember, isOwner, isCreator, setActiveCommunityId, membershipStatus, myCommunities,
  getActiveRole, setActiveRole, eligibleRoles, resolveEntryRole, subscribeCommunities,
  getCommunities, findUnseenGrantFor, markGrantSeen, communityCacheReady,
  buyerRequestStatus, requestBuyerRole, refreshCommunityCache,
  consumeJoinIntentFromUrl, getPendingJoinCode,
  leaveCommunity, mySuspendedMemberships,
} from './community.js';
import {
  subscribeNotifications, getNotificationsFor, getUnreadCount,
  markRead, markUnread, markAllRead, deleteNotification, getPreferences, savePreferences,
  refreshNotificationCache,
} from './notifications.js';
import { canAccessSite, refreshSitesCache } from './sites.js';
import { sendFeedback, feedbackCooldownRemaining, milestoneFeedbackPending, markMilestoneFeedbackDone } from './feedback.js';
import { refreshOrderCache, getOrders } from './orderLifecycle.js';
import { refreshMessageCache } from './orderMessages.js';
import { refreshPhotoCache } from './deliveryPhotos.js';
import { refreshSupplierCache } from './suppliers.js';
import { refreshOffersCache } from './offers.js';
import { billingEnabled, startCheckout, consumeBillingReturnFromUrl } from './billing.js';
import { refreshProductsCache } from './products.js';
import { startRealtimeForSession, stopRealtime } from './realtime.js';
import { installErrorReporting } from './errorLog.js';
import { refreshAppStatus, getAppStatus } from './appStatus.js';

// Beta: catch uncaught errors / rejections and log them to Supabase. Done
// here at module load (not in bootstrap) so an error thrown during bootstrap
// itself is still captured. Adds two window listeners and nothing else.
installErrorReporting();

// Phase 8B/8C: identity/company/site/order data is now Supabase-backed and
// shared across devices, but there's no Realtime subscription yet
// (deliberately deferred - see CLAUDE.md) - freshness comes from explicit
// refetch-on-write (community.js/sites.js/orderLifecycle.js's own writers),
// refetch-on-view-entry (this helper, called from the routing functions
// below that actually render community/site/order-dependent content), and
// refetch-on-window-focus (wired at the bottom of this file). None of this
// is the security boundary - RLS/the RPC functions are - so a failed/slow
// refresh here degrades to "briefly stale UI," never to a false permission
// grant or a lifecycle action succeeding when it shouldn't.
async function refreshDataCaches() {
  try {
    await Promise.all([refreshCommunityCache(), refreshSitesCache(), refreshOrderCache(), refreshNotificationCache(), refreshSupplierCache(), refreshOffersCache(), refreshProductsCache(), refreshMessageCache(), refreshPhotoCache()]);
  } catch (err) {
    console.error('SiteStock: failed to refresh community/site/order/notification/supplier/product data', err);
  }
}

const bootstrapLoadingView = document.getElementById('bootstrap-loading');
const landingView = document.getElementById('landing-view');
const appTopbar = document.querySelector('.topbar');
const appMain = document.getElementById('app');
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
let confirmingDeleteAccount = false;
let changingEmail = false;
let changingName = false;
let mfaEnrollment = null; // { factorId, qrSvg, secret } while turning 2FA on
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
const feedbackModal = document.getElementById('feedback-modal');
const feedbackIntro = document.getElementById('feedback-intro');
const feedbackForm = document.getElementById('feedback-form');
const feedbackThanks = document.getElementById('feedback-thanks');
const feedbackInput = document.getElementById('feedback-input');
const feedbackCount = document.getElementById('feedback-count');
const feedbackStatus = document.getElementById('feedback-status');
const feedbackSendBtn = document.getElementById('feedback-send-btn');
const feedbackCancelBtn = document.getElementById('feedback-cancel-btn');
const feedbackCloseBtn = document.getElementById('feedback-close-btn');
const footerFeedbackBtn = document.getElementById('footer-feedback-btn');
const premiumUpgradeModal = document.getElementById('premium-upgrade-modal');
const premiumUpgradeCloseBtn = document.getElementById('premium-upgrade-close-btn');
// Lives on the Sites screen's own static markup (see sitesView.js's
// renderPlanStatus) - not a lazy-module import, just a button main.js
// already owns like every other modal trigger (see DIALOGS below).
const sitePlanSeePremiumBtn = document.getElementById('site-plan-see-premium-btn');
const premiumUpgradeHint = document.getElementById('premium-upgrade-hint');
const premiumUpgradeMailto = document.getElementById('premium-upgrade-mailto');
const premiumUpgradeCheckoutBtn = document.getElementById('premium-upgrade-checkout-btn');
const premiumUpgradeFootnote = document.getElementById('premium-upgrade-footnote');
const premiumUpgradeError = document.getElementById('premium-upgrade-error');
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

const ALL_VIEWS = [landingView, authView, communityView, communitiesView, profileView, roleSelectView, workerView, ownerView, driverView, buyerView, sitesView];

const killSwitchPanel = document.getElementById('kill-switch-panel');
const killSwitchMessage = document.getElementById('kill-switch-message');
let killScreenShown = false;

// Full-screen maintenance message - shown instead of the app when
// app_status.killed is true (migration 0042). Tears down Realtime and hides
// every view; recovery is a page reload (handled by the focus listener when
// the flag is cleared).
function showKillScreen(message) {
  killScreenShown = true;
  killSwitchMessage.textContent = message
    || 'SiteStock is briefly offline for maintenance. Please check back shortly.';
  bootstrapLoadingView.classList.remove('active');
  ALL_VIEWS.forEach(v => v.classList.remove('active'));
  killSwitchPanel.hidden = false;
  try { stopRealtime(); } catch { /* ignore */ }
}

const ROLE_META = {
  owner: { label: 'Owner', desc: 'Approve worker requests and company join requests' },
  worker: { label: 'Worker', desc: 'Search for materials and place order requests' },
  driver: { label: 'Driver', desc: 'Pick up approved orders and deliver them' },
  buyer: { label: 'Buyer', desc: 'Purchase approved orders and confirm the purchase' },
};

// SPA route change: a class swap alone leaves a keyboard/screen-reader user
// stranded on the now-hidden control they just clicked (focus falls to
// <body>), with no signal the screen changed. So on every genuine
// navigation we move focus into the new view (each <section class="view">
// has tabindex="-1" + an aria-label), reset scroll, retitle the tab, and
// announce the view name through #route-announcer (a visually-hidden
// polite live region). Skipped on the very first render so a fresh page
// load doesn't yank focus.
const routeAnnouncer = document.getElementById('route-announcer');
let hasRoutedOnce = false;
function showOnly(view) {
  const isChange = !view.classList.contains('active');
  ALL_VIEWS.forEach(v => v.classList.toggle('active', v === view));
  // The landing page brings its own full header (logo, nav, Log in/Create
  // account) - showing the app's own topbar above it would look like a
  // duplicate header. Every other view keeps the real topbar as normal.
  if (appTopbar) appTopbar.hidden = (view === landingView);
  // main#app is a narrow 720px centered column, right for every dashboard
  // panel view but wrong for the landing page's own full-bleed marketing
  // layout (edge-to-edge hero/sections up to 1440px). Toggle the constraint
  // off only while landing-view is showing.
  if (appMain) appMain.classList.toggle('app-full-bleed', view === landingView);
  // Defensive cleanup, independent of landing.js's own closeInternalPage
  // fix for the same bug: landing.css's body.layer-open sets
  // overflow:hidden while the landing page's internal "How it works"/
  // "Problems"/"Get Started" overlay is open, and main.js has no import-
  // level knowledge of that module's state. A real bug (2026-09-14) left
  // this class stuck after navigating away from landing-view via its
  // internal "Get Started for Free" CTA, breaking scroll for the rest of
  // the session (auth form, then the whole authenticated app). Belt and
  // braces: leaving landing-view by ANY path always clears it here too.
  if (view !== landingView) document.body.classList.remove('layer-open');
  const label = view.getAttribute('aria-label') || '';
  if (label) document.title = `${label} · SiteStock`;
  if (hasRoutedOnce && isChange) {
    try { window.scrollTo(0, 0); } catch { /* jsdom / restricted context */ }
    try { view.focus({ preventScroll: true }); } catch { /* older browsers */ }
    if (routeAnnouncer && label) {
      // Clear then re-set on a short delay so the live region fires even
      // when two routes land in quick succession or the new name matches
      // the last. setTimeout (not rAF) so it still runs if the tab briefly
      // loses visibility mid-navigation.
      routeAnnouncer.textContent = '';
      setTimeout(() => { routeAnnouncer.textContent = label; }, 60);
    }
  }
  hasRoutedOnce = true;
}

// --- Lazy-loaded views ----------------------------------------------
// Dynamic import() with a small promise cache. import() already dedupes on
// its own (a second call for the same specifier returns the same module),
// but caching the promise here also lets a failed first fetch (flaky
// network on the very first navigation into a role) be retried instead of
// permanently wedging that view. Each module's top-level side effects (its
// subscribeX render hooks, its revert-countdown setInterval) run on this
// first import - which is exactly when its view first matters; showRoleView/
// showSitesView still call refreshXView() on every entry, and the pub-sub
// convention re-runs each listener immediately on subscribe, so nothing
// renders stale. Same-origin import() is permitted by the page CSP
// (script-src 'self').
const _viewModules = new Map();
function loadView(path) {
  let p = _viewModules.get(path);
  if (!p) {
    p = import(path).catch(err => { _viewModules.delete(path); throw err; });
    _viewModules.set(path, p);
  }
  return p;
}

const ROLE_VIEW_MODULE = {
  worker: './site.js',
  owner: './owner.js',
  driver: './driver.js',
  buyer: './buyer.js',
};

// --- View-transition loading veil ----------------------------------
// Every transition (showRoleView/showSitesView/showCommunitiesView/
// showProfile/showRoleSelect/enterCommunityFlow) leaves the previous
// screen up while its async work runs - a cache refresh, and since
// lazy-loading, possibly the first fetch of a role/screen module - then
// swaps in the finished view. Invisible on a fast connection, a dead
// feedback-free pause on a slow one. beginViewLoading() arms a veil that
// only appears once the wait passes ~150ms (so quick transitions never
// flash it) and then stays for at least ~350ms (so it can't strobe).
// Refcounted: enterCommunityFlow -> showRoleView both wrap, and the veil
// only clears when the outermost transition finishes.
const viewLoadingEl = document.getElementById('view-loading');
const VIEW_LOADING_DELAY_MS = 150;
const VIEW_LOADING_MIN_SHOW_MS = 350;
let viewLoadingDepth = 0;
let viewLoadingShowTimer = null;
let viewLoadingHideTimer = null;
let viewLoadingShownAt = 0;

function beginViewLoading() {
  viewLoadingDepth++;
  if (viewLoadingHideTimer !== null) { clearTimeout(viewLoadingHideTimer); viewLoadingHideTimer = null; }
  if (viewLoadingShowTimer === null && viewLoadingEl.hidden) {
    viewLoadingShowTimer = setTimeout(() => {
      viewLoadingShowTimer = null;
      if (viewLoadingDepth > 0) {
        viewLoadingEl.hidden = false;
        viewLoadingShownAt = Date.now();
      }
    }, VIEW_LOADING_DELAY_MS);
  }
}

function endViewLoading() {
  viewLoadingDepth = Math.max(0, viewLoadingDepth - 1);
  if (viewLoadingDepth > 0) return;
  if (viewLoadingShowTimer !== null) { clearTimeout(viewLoadingShowTimer); viewLoadingShowTimer = null; }
  if (viewLoadingEl.hidden || viewLoadingHideTimer !== null) return;
  const remaining = VIEW_LOADING_MIN_SHOW_MS - (Date.now() - viewLoadingShownAt);
  if (remaining <= 0) {
    viewLoadingEl.hidden = true;
  } else {
    viewLoadingHideTimer = setTimeout(() => {
      viewLoadingHideTimer = null;
      if (viewLoadingDepth === 0) viewLoadingEl.hidden = true;
    }, remaining);
  }
}

// Wrap an async transition function so it drives the veil on every path
// (including a thrown error or an early return). The refcount in
// begin/endViewLoading makes nesting safe.
function guardTransition(fn) {
  return async function guardedTransition(...args) {
    beginViewLoading();
    try {
      return await fn.apply(this, args);
    } finally {
      endViewLoading();
    }
  };
}

// True whenever the current user actually owns the active community - a
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
  // Feedback needs a real account (the table is authenticated-only insert).
  if (footerFeedbackBtn) footerFeedbackBtn.hidden = !isAuthenticated();
}

function showAuth() {
  showOnly(authView);
  sessionBar.hidden = true;
  profilePillBtn.hidden = true;
  communitiesPillBtn.hidden = true;
  sitesPillBtn.hidden = true;
  notifWrap.hidden = true;
  notifPanel.hidden = true;
  if (footerFeedbackBtn) footerFeedbackBtn.hidden = true;
  communityIndicator.textContent = 'Orders & Deliveries';
}

// Marketing homepage - the front door for a logged-out visitor. routeFromTop()
// shows this instead of showAuth() on a fresh unauthenticated visit; its own
// CTAs (data-auth-target, wired below) route into the real auth-view.
function showLanding() {
  showOnly(landingView);
  sessionBar.hidden = true;
  profilePillBtn.hidden = true;
  communitiesPillBtn.hidden = true;
  sitesPillBtn.hidden = true;
  notifWrap.hidden = true;
  notifPanel.hidden = true;
  if (footerFeedbackBtn) footerFeedbackBtn.hidden = true;
}

function showCommunityPicker() {
  showOnly(communityView);
  sessionBar.hidden = true;
  communityIndicator.textContent = 'Orders & Deliveries';
  updateTopRightPills();
}

const showCommunitiesView = guardTransition(showCommunitiesViewImpl);
async function showCommunitiesViewImpl() {
  showOnly(communitiesView);
  sessionBar.hidden = true;
  communityIndicator.textContent = 'Orders & Deliveries';
  updateTopRightPills();
  await refreshDataCaches();
  // Roadmap Step 5 - the one deliberate place a held invite-link code is
  // actually consumed (read + cleared) - see communityView.js's
  // applyPendingJoinIntent header for why this must NOT be wired into that
  // view's own reactive render() instead.
  applyPendingJoinIntent();
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

const showProfile = guardTransition(showProfileImpl);
async function showProfileImpl() {
  await refreshDataCaches();

  const account = getLoggedInAccount();
  const userId = getCurrentUserId();
  const displayName = getCurrentDisplayName();
  const mfaOn = await getMfaEnabled();

  const memberships = myCommunities(userId).map(c => ({
    id: c.id,
    name: c.name,
    role: membershipStatus(c.id, userId) === 'owner' ? 'Owner' : 'Member',
    isCreator: isCreator(c.id, userId),
    buyerStatus: buyerRequestStatus(c.id, userId),
  }));

  // Migration 0023 - a suspended member can still see the company row
  // (communities_select_scoped includes 'suspended') and their own
  // membership row (with the reason). Surface it so they know why they've
  // lost access and can't get back in until an owner restores them.
  const suspended = mySuspendedMemberships(userId).map(m => {
    const c = getCommunities().find(x => x.id === m.communityId);
    return {
      name: c ? c.name : 'a company',
      reason: m.statusReason,
      by: m.statusChangedById ? resolveDisplayName(m.statusChangedById) : null,
    };
  });

  profileDetails.innerHTML = `
    <div class="profile-field">
      <span class="profile-label">Display name</span>
      <span class="profile-value">${escapeHtml(displayName || ' - ')}</span>
      ${changingName ? `
        <div class="reject-form">
          <label class="field-label" for="change-name-input">New display name</label>
          <input type="text" id="change-name-input" class="text-input" maxlength="60" value="${escapeHtml(displayName || '')}" />
          <p class="hint small-hint">This is how your name shows on orders and team lists. It's cosmetic only - it never changes your access.</p>
          <div class="reject-form-actions">
            <button class="btn btn-secondary" id="change-name-cancel-btn">Cancel</button>
            <button class="btn btn-primary" id="change-name-confirm-btn">Save</button>
          </div>
          <p id="change-name-status" class="form-status"></p>
        </div>
      ` : `<button type="button" class="link-btn" id="profile-change-name-btn">Change name</button>`}
    </div>
    ${account ? `
      <div class="profile-field">
        <span class="profile-label">Email</span>
        <span class="profile-value">${escapeHtml(account.email)}</span>
        ${changingEmail ? `
          <div class="reject-form">
            <label class="field-label" for="change-email-input">New email address</label>
            <input type="email" id="change-email-input" class="text-input" placeholder="you@example.com" />
            <p class="hint small-hint">We'll send a confirmation link to the new address - the change only takes effect once you follow it.</p>
            <div class="reject-form-actions">
              <button class="btn btn-secondary" id="change-email-cancel-btn">Cancel</button>
              <button class="btn btn-primary" id="change-email-confirm-btn">Send confirmation</button>
            </div>
            <p id="change-email-status" class="form-status"></p>
          </div>
        ` : `<button type="button" class="link-btn" id="profile-change-email-btn">Change email</button>`}
      </div>
      <div class="profile-field">
        <span class="profile-label">Account created</span>
        <span class="profile-value">${new Date(account.createdAt).toLocaleDateString()}</span>
      </div>
      <div class="profile-field">
        <span class="profile-label">Two-factor authentication</span>
        <span class="profile-value">${mfaOn ? 'On. A code from your authenticator app is required at login.' : 'Off'}</span>
        ${mfaEnrollment ? `
          <div class="reject-form">
            <p class="hint small-hint">1. In your authenticator app (Google Authenticator, Authy, 1Password…), add an account and scan this QR code - or type the key manually.</p>
            <div class="mfa-qr">${mfaEnrollment.qrSvg}</div>
            <p class="hint small-hint">Setup key: <code>${escapeHtml(mfaEnrollment.secret)}</code></p>
            <label class="field-label" for="mfa-enroll-code-input">2. Enter the 6-digit code it shows</label>
            <input type="text" id="mfa-enroll-code-input" class="text-input" inputmode="numeric" maxlength="6" placeholder="123456" />
            <div class="reject-form-actions">
              <button class="btn btn-secondary" id="mfa-enroll-cancel-btn">Cancel</button>
              <button class="btn btn-primary" id="mfa-enroll-confirm-btn">Turn on 2FA</button>
            </div>
            <p id="mfa-enroll-status" class="form-status"></p>
          </div>
        ` : (mfaOn
          ? `<button type="button" class="link-btn link-btn-danger" id="mfa-disable-btn">Turn off 2FA</button><p id="mfa-status" class="form-status"></p>`
          : `<button type="button" class="link-btn" id="mfa-enable-btn">Turn on 2FA</button><p id="mfa-status" class="form-status"></p>`)}
      </div>
    ` : ''}
    <div class="profile-field">
      <span class="profile-label">Companies (${memberships.length})</span>
      <div class="profile-communities">
        ${memberships.length === 0
          ? '<span class="profile-value">Not in any companies yet</span>'
          : memberships.map(m => `
            <div class="profile-community-row">
              <strong>${escapeHtml(m.name)}</strong>
              <span class="status-badge status-pending">${m.role}</span>
              ${renderBuyerBadge(m)}
              ${m.isCreator ? '' : `<button type="button" class="link-btn link-btn-danger" data-leave-company="${m.id}" data-company-name="${escapeHtml(m.name)}">Leave this company</button>`}
            </div>
          `).join('')}
      </div>
    </div>
    ${suspended.length ? `
      <div class="profile-field">
        <span class="profile-label">Suspended</span>
        <div class="profile-communities">
          ${suspended.map(s => `
            <div class="profile-community-row profile-community-suspended">
              <strong>${escapeHtml(s.name)}</strong>
              <span class="status-badge status-suspended">Suspended</span>
              <span class="profile-value">${s.reason ? `Reason: ${escapeHtml(s.reason)}` : 'Your access here is paused'}${s.by ? ` - by ${escapeHtml(s.by)}` : ''}. Ask an owner to restore your access.</span>
            </div>
          `).join('')}
        </div>
      </div>
    ` : ''}
    <div class="profile-field">
      <span class="profile-label">Your data</span>
      <span class="profile-value">SiteStock records, against your account:</span>
      <ul class="profile-data-list">
        <li>your email address and display name${mfaOn ? ', and the secret behind your two-factor codes' : ''} (your password is only ever stored as a one-way hash, by our login provider)</li>
        <li>every company, site, order, approval, cancellation, delivery and in-app message you create or act on - with your name and the time against each one</li>
        <li>any delivery photos you upload</li>
        <li>your notifications and notification settings</li>
        <li>any feedback you send us through the &ldquo;Send feedback&rdquo; box</li>
        <li>a record that a supplier link was opened for an order (which order and supplier, and when - not who clicked, so it isn't tied to your account)</li>
        <li>if you're a driver and choose to share it, an approximate location from your device - used only to sort nearby pickups, not stored long-term</li>
        <li>standard security logs (your IP address, request times) and, if the app hits an error, a diagnostic report your browser sends us</li>
      </ul>
      <span class="profile-value">We never sell it, and we don't use advertising or cross-site tracking. Who can see what, how long it's kept, and your rights are in the <a href="privacy.html" target="_blank" rel="noopener">Privacy Policy</a>.</span>
    </div>
    <button type="button" class="btn btn-secondary btn-block" id="profile-logout-btn">Log out</button>
    ${confirmingDeleteAccount ? `
      <div class="reject-form">
        <p class="hint small-hint">This permanently deletes your login and personal details - your email, password, sign-in sessions, two-factor setup, notifications and settings. Your <strong>name stays</strong> on your companies' past orders, messages and history so their records aren't broken, and you're removed from every team. You can't do this while you still own a company - transfer it or delete it first. Type DELETE to confirm.</p>
        <input type="text" id="delete-account-confirm-input" class="text-input" placeholder="DELETE" />
        <div class="reject-form-actions">
          <button class="btn btn-secondary" id="delete-account-cancel-btn">Never mind</button>
          <button class="btn btn-primary" id="delete-account-confirm-btn">Delete my account</button>
        </div>
        <p id="delete-account-status" class="form-status"></p>
      </div>
    ` : `<button type="button" class="link-btn link-btn-danger" id="profile-delete-account-btn">Delete my account</button>`}
  `;

  document.getElementById('profile-logout-btn').addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('sitestock:logout'));
  });

  const mfaEnableBtn = document.getElementById('mfa-enable-btn');
  if (mfaEnableBtn) {
    mfaEnableBtn.addEventListener('click', async () => {
      mfaEnableBtn.disabled = true;
      const result = await startMfaEnrollment();
      if (result.error) {
        const s = document.getElementById('mfa-status');
        if (s) { s.textContent = result.error; s.className = 'form-status error'; }
        mfaEnableBtn.disabled = false;
        return;
      }
      mfaEnrollment = result;
      showProfile();
    });
  }
  const mfaEnrollCancelBtn = document.getElementById('mfa-enroll-cancel-btn');
  if (mfaEnrollCancelBtn) {
    mfaEnrollCancelBtn.addEventListener('click', () => { mfaEnrollment = null; showProfile(); });
  }
  const mfaEnrollConfirmBtn = document.getElementById('mfa-enroll-confirm-btn');
  if (mfaEnrollConfirmBtn) {
    mfaEnrollConfirmBtn.addEventListener('click', async () => {
      const input = document.getElementById('mfa-enroll-code-input');
      const status = document.getElementById('mfa-enroll-status');
      mfaEnrollConfirmBtn.disabled = true;
      const result = await confirmMfaEnrollment(mfaEnrollment.factorId, input.value);
      if (result.error) {
        mfaEnrollConfirmBtn.disabled = false;
        status.textContent = result.error;
        status.className = 'form-status error';
        input.select();
        return;
      }
      mfaEnrollment = null;
      showProfile();
    });
  }
  const mfaDisableBtn = document.getElementById('mfa-disable-btn');
  if (mfaDisableBtn) {
    mfaDisableBtn.addEventListener('click', async () => {
      if (!window.confirm('Turn off two-factor authentication? Your account will only be protected by your password.')) return;
      mfaDisableBtn.disabled = true;
      const result = await disableMfa();
      const s = document.getElementById('mfa-status');
      if (result.error && s) { s.textContent = result.error; s.className = 'form-status error'; mfaDisableBtn.disabled = false; return; }
      showProfile();
    });
  }

  const changeNameStartBtn = document.getElementById('profile-change-name-btn');
  if (changeNameStartBtn) {
    changeNameStartBtn.addEventListener('click', () => {
      changingName = true;
      showProfile();
    });
  }
  const changeNameCancelBtn = document.getElementById('change-name-cancel-btn');
  if (changeNameCancelBtn) {
    changeNameCancelBtn.addEventListener('click', () => {
      changingName = false;
      showProfile();
    });
  }
  const changeNameConfirmBtn = document.getElementById('change-name-confirm-btn');
  if (changeNameConfirmBtn) {
    changeNameConfirmBtn.addEventListener('click', async () => {
      const input = document.getElementById('change-name-input');
      const statusEl = document.getElementById('change-name-status');
      changeNameConfirmBtn.disabled = true;
      const result = await updateDisplayName(input.value);
      if (result.error) {
        changeNameConfirmBtn.disabled = false;
        statusEl.textContent = result.error;
        statusEl.className = 'form-status error';
        return;
      }
      changingName = false;
      showProfile();
    });
  }

  const changeEmailStartBtn = document.getElementById('profile-change-email-btn');
  if (changeEmailStartBtn) {
    changeEmailStartBtn.addEventListener('click', () => {
      changingEmail = true;
      showProfile();
    });
  }
  const changeEmailCancelBtn = document.getElementById('change-email-cancel-btn');
  if (changeEmailCancelBtn) {
    changeEmailCancelBtn.addEventListener('click', () => {
      changingEmail = false;
      showProfile();
    });
  }
  const changeEmailConfirmBtn = document.getElementById('change-email-confirm-btn');
  if (changeEmailConfirmBtn) {
    changeEmailConfirmBtn.addEventListener('click', async () => {
      const input = document.getElementById('change-email-input');
      const statusEl = document.getElementById('change-email-status');
      changeEmailConfirmBtn.disabled = true;
      const result = await requestEmailChange(input.value);
      changeEmailConfirmBtn.disabled = false;
      if (result.error) {
        statusEl.textContent = result.error;
        statusEl.className = 'form-status error';
        return;
      }
      statusEl.textContent = 'Confirmation link sent. Check your new inbox - your email changes once you follow it.';
      statusEl.className = 'form-status success';
    });
  }

  const deleteStartBtn = document.getElementById('profile-delete-account-btn');
  if (deleteStartBtn) {
    deleteStartBtn.addEventListener('click', () => {
      confirmingDeleteAccount = true;
      showProfile();
    });
  }
  const deleteCancelBtn = document.getElementById('delete-account-cancel-btn');
  if (deleteCancelBtn) {
    deleteCancelBtn.addEventListener('click', () => {
      confirmingDeleteAccount = false;
      showProfile();
    });
  }
  const deleteConfirmBtn = document.getElementById('delete-account-confirm-btn');
  if (deleteConfirmBtn) {
    deleteConfirmBtn.addEventListener('click', async () => {
      const input = document.getElementById('delete-account-confirm-input');
      const statusEl = document.getElementById('delete-account-status');
      if ((input.value || '').trim().toUpperCase() !== 'DELETE') {
        statusEl.textContent = 'Type DELETE exactly to confirm.';
        statusEl.className = 'form-status error';
        return;
      }
      deleteConfirmBtn.disabled = true;
      statusEl.textContent = 'Deleting…';
      statusEl.className = 'form-status';
      const result = await deleteAccount();
      if (!result.ok) {
        deleteConfirmBtn.disabled = false;
        statusEl.textContent = result.error;
        statusEl.className = 'form-status error';
        return;
      }
      // The account is gone server-side; reuse the exact same cleanup +
      // routing a normal Log-out click already goes through (stop Realtime,
      // clear the active community, close open panels, clear the session,
      // route to auth-view) rather than duplicating any of it here.
      window.dispatchEvent(new CustomEvent('sitestock:logout'));
    });
  }

  profileDetails.querySelectorAll('[data-leave-company]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const communityId = btn.dataset.leaveCompany;
      const name = btn.dataset.companyName;
      if (!window.confirm(`Leave "${name}"? You lose access and any owner or buyer access and site assignments. You can ask to rejoin later.`)) return;
      btn.disabled = true;
      const result = await leaveCommunity(communityId);
      if (!result.ok) {
        btn.disabled = false;
        alert(result.error);
        return;
      }
      // If the company they just left is the active one, route out of it;
      // otherwise just re-render the profile (the row is now gone).
      if (getActiveCommunityId() === communityId) setActiveCommunityId(null);
      showProfile();
    });
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

const showRoleSelect = guardTransition(showRoleSelectImpl);
async function showRoleSelectImpl() {
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
        <span class="role-select-info">
          <strong>${meta.label}</strong>
          <span>${meta.desc}</span>
        </span>
        <span class="variant-option-arrow" aria-hidden="true"></span>
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
  communityIndicator.textContent = `${community.name} - ${displayName}`;
  communityCircleBtn.textContent = getInitials(community.name);
  updateTopRightPills();
}

const showRoleView = guardTransition(showRoleViewImpl);
async function showRoleViewImpl() {
  const role = getActiveRole();
  // Kick the role's view module download off now so it runs concurrently
  // with the cache refresh below (both are independent; the cache fetch is
  // the slower, network-bound one). Awaited further down, right before the
  // view is revealed. A stale role that fails validation just leaves this
  // fetch to finish harmlessly in the background - the module is then warm
  // for a later legitimate entry.
  const modulePromise = ROLE_VIEW_MODULE[role] ? loadView(ROLE_VIEW_MODULE[role]) : null;

  await refreshDataCaches();

  const community = getActiveCommunity();
  const userId = getCurrentUserId();
  const displayName = getCurrentDisplayName();

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

  let view;
  try {
    view = await modulePromise;
  } catch (err) {
    console.error('SiteStock: failed to load the view for role', role, err);
    alert("Couldn't load that screen - check your connection and try again.");
    showCommunityPicker();
    return;
  }

  communityIndicator.textContent = `${community.name} - ${displayName}`;
  sessionBar.hidden = false;
  // Phase 8E fix: this used to hide "Switch role" whenever the account had
  // a defaultRole - since every real account now has one (guest mode is
  // gone), that hid it for 100% of accounts, regardless of whether they
  // actually had more than one legitimate role to switch to. The correct
  // condition is simply "is there anything else to switch to."
  menuSwitchRoleBtn.hidden = roles.length <= 1;
  sessionLabel.textContent = `Logged in as ${ROLE_META[role].label}`;
  communityCircleBtn.textContent = getInitials(community.name);
  updateTopRightPills();

  if (role === 'worker') {
    showOnly(workerView);
    view.refreshWorkerView();
    highlightOrderIfPending();
  } else if (role === 'owner') {
    showOnly(ownerView);
    view.refreshOwnerView(pendingNotifOrderId);
    pendingNotifOrderId = null;
  } else if (role === 'driver') {
    showOnly(driverView);
    view.refreshDriverView();
    highlightOrderIfPending();
  } else if (role === 'buyer') {
    showOnly(buyerView);
    // Awaited (unlike the other three roles' refresh calls) because
    // refreshBuyerView is itself async since Phase 8C - it awaits
    // releaseHoldIfAny(), a real abandonPurchase RPC, before it's safe to
    // treat the Buyer view as actually refreshed.
    await view.refreshBuyerView(pendingNotifOrderId);
    pendingNotifOrderId = null;
  }

  maybePromptFeedback();
}

// --- Feedback --------------------------------------------------------
// Footer "Send feedback" any time; plus one gentle prompt the first time
// the user's active company has a completed delivery. Everything writes
// one row to the private `feedback` table (feedback.js).
let feedbackContext = 'general';

function openFeedback(context) {
  feedbackContext = context;
  feedbackForm.hidden = false;
  feedbackThanks.hidden = true;
  feedbackInput.value = '';
  feedbackCount.textContent = '0';
  feedbackStatus.textContent = '';
  feedbackStatus.className = 'form-status';
  feedbackIntro.textContent = context === 'milestone_first_delivery'
    ? "You've had your first delivery through SiteStock. How's it going so far - anything clunky, confusing, or missing? This goes straight to the person who builds it, not a public review."
    : "Tell us what's working, what isn't, or what you wish it did. This goes straight to the person who builds SiteStock - it's not a public review.";
  feedbackSendBtn.disabled = false;
  feedbackModal.hidden = false;
}

function closeFeedback() {
  feedbackModal.hidden = true;
}

function maybePromptFeedback() {
  if (!milestoneFeedbackPending()) return;
  if (!isAuthenticated()) return;
  const community = getActiveCommunity();
  if (!community) return;
  const hasDelivered = getOrders().some(o => o.communityId === community.id && o.status === 'delivered');
  if (!hasDelivered) return;
  // Don't jump in front of another dialog or the notification panel.
  if (document.querySelector('.modal-overlay:not([hidden])') || !notifPanel.hidden) return;
  markMilestoneFeedbackDone();               // once ever, even if they dismiss
  setTimeout(() => {
    if (document.querySelector('.modal-overlay:not([hidden])')) return;
    openFeedback('milestone_first_delivery');
  }, 1500);
}

footerFeedbackBtn?.addEventListener('click', () => openFeedback('general'));
feedbackCancelBtn.addEventListener('click', closeFeedback);
feedbackCloseBtn.addEventListener('click', closeFeedback);
feedbackInput.addEventListener('input', () => {
  feedbackCount.textContent = String(feedbackInput.value.length);
});

feedbackSendBtn.addEventListener('click', async () => {
  const remaining = feedbackCooldownRemaining();
  if (remaining > 0) {
    feedbackStatus.textContent = `Just a moment - you can send again in ${Math.ceil(remaining / 1000)}s.`;
    feedbackStatus.className = 'form-status error';
    return;
  }
  feedbackSendBtn.disabled = true;
  feedbackStatus.textContent = 'Sending…';
  feedbackStatus.className = 'form-status';
  const result = await sendFeedback(feedbackInput.value, feedbackContext);
  if (!result.ok) {
    feedbackStatus.textContent = result.error;
    feedbackStatus.className = 'form-status error';
    feedbackSendBtn.disabled = false;
    return;
  }
  feedbackForm.hidden = true;
  feedbackThanks.hidden = false;
});

// "Upgrade to Premium" pop-up (migration 0052) - trigger lives on the
// Sites screen's static markup, but like every other modal it's opened/
// closed from here, not from sitesView.js, so the lazy-loaded module
// never needs to know this dialog exists (see "Things NOT to do" in
// CLAUDE.md on not statically importing the five role/screen modules).
// Two faces, chosen by the billing flag (public/js/env.js): with billing off
// the pop-up is the "not available yet" notice with a mailto link; with it on,
// the mailto is replaced by a real checkout button. The flag is the only thing
// that differs - both faces share this one dialog so the focus-trap/Escape
// wiring below covers either.
function syncPremiumModal() {
  const on = billingEnabled();
  premiumUpgradeMailto.hidden = on;
  premiumUpgradeCheckoutBtn.hidden = !on;
  premiumUpgradeError.hidden = true;
  if (on) {
    premiumUpgradeHint.textContent = "You've reached the 2-site limit on the Free plan. Premium removes it completely for £10/month.";
    premiumUpgradeFootnote.textContent = "You'll pay on Stripe's secure page. Cancel any time from Company settings.";
  }
}
sitePlanSeePremiumBtn?.addEventListener('click', () => {
  syncPremiumModal();
  premiumUpgradeModal.hidden = false;
});
premiumUpgradeCheckoutBtn?.addEventListener('click', async () => {
  const communityId = getActiveCommunityId();
  if (!communityId) return;
  premiumUpgradeCheckoutBtn.disabled = true;
  premiumUpgradeError.hidden = true;
  const result = await startCheckout(communityId);
  // On success the browser is already leaving for Stripe; only a failure returns here.
  if (!result.ok) {
    premiumUpgradeCheckoutBtn.disabled = false;
    premiumUpgradeError.textContent = result.error;
    premiumUpgradeError.hidden = false;
  }
});
// Coming back with the browser's Back button restores this page from the
// bfcache with the button still disabled from the click that left it.
window.addEventListener('pageshow', e => {
  if (e.persisted && premiumUpgradeCheckoutBtn) premiumUpgradeCheckoutBtn.disabled = false;
});
premiumUpgradeCloseBtn.addEventListener('click', () => { premiumUpgradeModal.hidden = true; });

// Sites is reached only from inside an active owner session (the pill
// itself is only ever visible when hasActiveOwnerSession() is true), so
// this deliberately doesn't re-derive community/role chrome the way
// showRoleView does - it just swaps which section is visible and keeps the
// existing session bar.
const showSitesView = guardTransition(showSitesViewImpl);
async function showSitesViewImpl(siteId = null) {
  let view;
  try {
    // refreshDataCaches never rejects (it catches internally), so Promise.all
    // here only rejects if the sitesView.js fetch itself fails. Load before
    // revealing the section so the veil covers the previous screen rather
    // than an empty #sites-view.
    [view] = await Promise.all([loadView('./sitesView.js'), refreshDataCaches()]);
  } catch (err) {
    console.error('SiteStock: failed to load the Sites view', err);
    alert("Couldn't load Sites - check your connection and try again.");
    routeFromTop();
    return;
  }
  showOnly(sitesView);
  updateTopRightPills();
  view.refreshSitesView(siteId);
}

// Set right before routing into a role-view from a notification click, so
// that view can scroll to and briefly highlight the specific order the
// notification was about - the three flat-list views (worker/owner/driver)
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
const enterCommunityFlow = guardTransition(enterCommunityFlowImpl);
async function enterCommunityFlowImpl() {
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
  // branch needed here - every real account has one anyway (guest mode is
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
  // Roadmap Step 5 - a password-recovery link establishes a real, usable
  // session (so isAuthenticated() below would already be true), but the
  // user must land on the set-new-password form, not the community picker,
  // until they've actually finished resetting it. This check runs before
  // the authenticated check for exactly that reason - see auth.js's
  // inPasswordRecoveryContext header for the full race-condition rationale.
  if (inPasswordRecoveryContext()) {
    showAuth();
    return;
  }
  // Two-factor: password succeeded but the 6-digit code hasn't been entered
  // this login (session is aal1, a verified factor exists). Same gate shape
  // as password recovery - the auth view shows the code form.
  if (isMfaChallengePending()) {
    showAuth();
    return;
  }
  if (!isAuthenticated()) {
    showLanding();
    return;
  }
  // Roadmap Step 5 - a shareable invite link (`?join=CODE`) is consumed once
  // at bootstrap (see below) and held in memory until it's actually used.
  // An authenticated user with a pending join code is routed straight to
  // the Companies screen, whose join-code panel pre-fills from it - this is
  // navigation-only, never an implicit join: the existing "Request to join"
  // button still requires an explicit tap (see communityView.js).
  if (getPendingJoinCode()) {
    showCommunitiesView();
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

// Phase 8E - the owner dashboard's Sites summary card dispatches this
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
  // Phase 8D.2 - starts (or restarts, idempotently) Realtime for whichever
  // account just logged in. Safe even though community/order/notification
  // cache refreshes triggered by the auth transition may still be in
  // flight - every refreshXCache() this could race is itself a full,
  // idempotent replace, so "channel opens slightly before/after the first
  // cache load resolves" has no bad outcome either way.
  startRealtimeForSession();
  routeFromTop();
});

window.addEventListener('sitestock:logout', async () => {
  // Phase 8D.2 - stop BEFORE clearing session state, not after: this is
  // what guarantees no in-flight event from the outgoing account's channels
  // can still be processed once the auth transition below starts clearing
  // caches out from under it.
  stopRealtime();
  setActiveCommunityId(null);
  notifPanel.hidden = true;
  notifPrefsModal.hidden = true;
  // Awaited so the Supabase session is actually cleared (and the reactive
  // community/site cache refresh they trigger has fired) before routing - 
  // avoids a flash of the previous account's data on the auth screen.
  await authLogout();
  showAuth();
});

window.addEventListener('sitestock:go-to-auth', (e) => {
  showAuth();
  const tab = e.detail?.tab;
  if (tab === 'register' || tab === 'login') {
    document.querySelector(`#auth-tabs [data-auth-tab="${tab}"]`)?.click();
  }
});
window.addEventListener('sitestock:show-profile', () => showProfile());

// Landing page CTAs that go straight to auth (Log In / Create an Account /
// the "Get Started for Free" button inside the start-page-source info page)
// carry data-auth-target and are handled here. Every other "Get Started for
// Free" button carries data-page-target="start" instead, routing into the
// info page via landing.js's own in-page-layer nav - see index.html's
// landing-view and CLAUDE.md's "Landing page" section.
landingView.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-auth-target]');
  if (!btn) return;
  window.dispatchEvent(new CustomEvent('sitestock:go-to-auth', { detail: { tab: btn.dataset.authTarget } }));
});
// The active company was deleted from under us - drop it and go to the picker.
window.addEventListener('sitestock:active-community-gone', () => {
  setActiveCommunityId(null);
  setActiveRole(null);
  showCommunityPicker();
});

subscribeIdentity(checkForNewOwnerGrant);

subscribeCommunities(() => {
  // subscribeCommunities() itself calls this callback immediately/
  // synchronously at subscribe time (see community.js's pub-sub
  // convention), which runs before bootstrap()'s first refreshCommunityCache()
  // has ever completed - at that instant cache.communities is still its
  // module-level default ([]) and the auth session hasn't resolved yet
  // either (authReady is still pending), so getActiveCommunity()/
  // isApprovedMember() below would both read as "nothing" even for a
  // perfectly valid returning session. A real bug, found live: every
  // returning user with an already-active company got silently bounced
  // to the picker on every page load, because that first, pre-fetch call
  // satisfied the "access was lost" branch below on empty data alone.
  // communityCacheReady only flips true once a real fetch has actually
  // landed, so skip this callback's body entirely until then - the real
  // fetch's own completion fires this same listener again anyway.
  if (!communityCacheReady) return;
  checkForNewOwnerGrant();
  if (!getActiveCommunityId()) return;
  const community = getActiveCommunity();
  const userId = getCurrentUserId();
  if (!community || !isApprovedMember(community.id, userId)) {
    // Access to the active company was lost mid-session (suspended /
    // removed / left, or an owner grant went dormant). Migration 0023
    // makes isOwner/isApprovedMember reflect that after the Realtime-
    // triggered cache refresh; clear the now-invalid active company and
    // route to the picker. The membership_suspended/removed notification
    // (also just arrived via Realtime) explains why; a suspended user
    // additionally sees a "Suspended" section on their Profile.
    setActiveCommunityId(null);
    showCommunityPicker();
    return;
  }
  // Phase 8D.2 - live permission revalidation. This callback already fires
  // on every community-cache change regardless of cause (a same-tab write,
  // window-focus refresh, or - new this phase - a Realtime-triggered
  // refreshCommunityCache()/refreshSitesCache()), so the only new thing
  // here is the check itself, not a new trigger. Never treat a Realtime
  // event as proof of anything: by the time this callback runs, the cache
  // has already been authoritatively refetched under RLS, so
  // eligibleRoles() here reflects real, current, server-checked state - 
  // exactly what a fresh page load would compute, just running earlier
  // than the user's next navigation would have surfaced it. Mirrors
  // navigateToNotification's existing "a target is a wish, never an
  // authority" fallback shape below, just triggered by a live cache change
  // instead of a notification click.
  const role = getActiveRole();
  if (role && !eligibleRoles(community.id, userId).includes(role)) {
    setActiveRole(null);
    showRoleSelect();
    return;
  }

  // Keep the topbar in sync with a live company-cache change that isn't a
  // navigation - e.g. the owner renaming the company from Company settings,
  // or a rename arriving via Realtime. showRoleView/showRoleSelect set these
  // on view entry; this covers the "already on the page" case.
  if (!sessionBar.hidden) {
    const displayName = getCurrentDisplayName();
    communityIndicator.textContent = `${community.name} - ${displayName}`;
    communityCircleBtn.textContent = getInitials(community.name);
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

let notifShowAll = false;
const NOTIF_PAGE = 30;

function renderNotifList() {
  const userId = getCurrentUserId();
  const notifs = getNotificationsFor(userId);
  if (notifs.length === 0) {
    notifList.innerHTML = '<p class="empty-hint">No notifications yet.</p>';
    return;
  }
  const shown = notifShowAll ? notifs : notifs.slice(0, NOTIF_PAGE);
  const remaining = notifs.length - shown.length;
  notifList.innerHTML = shown.map(n => `
    <div class="notif-row${!n.read ? ' notif-row-unread' : ''}">
      <button type="button" class="notif-row-body" data-notif-open="${n.id}">
        <strong>${escapeHtml(n.title)}</strong>
        <span>${escapeHtml(n.message)}</span>
        <span class="notif-row-time">${timeAgo(n.createdAt)}</span>
      </button>
      <button type="button" class="notif-row-toggle" data-notif-toggle="${n.id}" title="${n.read ? 'Mark as unread' : 'Mark as read'}">${n.read ? '○' : '●'}</button>
      <button type="button" class="notif-row-delete" data-notif-delete="${n.id}" title="Remove this notification" aria-label="Remove this notification">&times;</button>
    </div>
  `).join('') + (remaining > 0
    ? `<button type="button" class="link-btn list-show-more" id="notif-show-more">Show ${remaining} older</button>`
    : '');

  const showMoreBtn = document.getElementById('notif-show-more');
  if (showMoreBtn) showMoreBtn.addEventListener('click', () => { notifShowAll = true; renderNotifList(); });

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
  notifList.querySelectorAll('[data-notif-delete]').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      btn.disabled = true;
      const result = await deleteNotification(btn.dataset.notifDelete);
      if (!result.ok) { btn.disabled = false; return; }
      renderNotifList();
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

// A notification's navigationTarget carries no authority of its own - 
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
    // real, current access - a stale notification can point somewhere, it
    // can never grant getting there. Drivers are the one deliberate
    // exception: Phase 4A never gave them a site permission function at
    // all (any approved member can claim any purchased order regardless of
    // site membership), so canAccessSite doesn't apply to driver-routed
    // targets - applying it there would incorrectly deny access drivers
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
  // membership, or site access, changed since it was created) - never open
  // the protected content, just route them to wherever they legitimately
  // belong now.
  routeFromTop();
}

notifBellBtn.addEventListener('click', e => {
  e.stopPropagation();
  accountMenu.hidden = true;
  notifPanel.hidden = !notifPanel.hidden;
  if (!notifPanel.hidden) { notifShowAll = false; renderNotifList(); }
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

// --- Dialog / popup keyboard behaviour -------------------------------
// Escape closes whatever transient surface is open (the two modal
// dialogs, or the two topbar popups), a modal takes focus on open and
// hands it back on close, and Tab is kept inside an open modal. The
// toggle buttons report their state with aria-expanded. Additive - the
// existing click handlers still own opening/closing.
const DIALOGS = [
  { el: ownerUpgradeModal, close: () => ownerUpgradeOkBtn.click() },
  { el: notifPrefsModal, close: () => notifPrefsCancelBtn.click() },
  { el: feedbackModal, close: () => (feedbackThanks.hidden ? feedbackCancelBtn : feedbackCloseBtn).click() },
  { el: premiumUpgradeModal, close: () => premiumUpgradeCloseBtn.click() },
];
let dialogOpener = null;

function dialogFocusables(el) {
  return [...el.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')]
    .filter(n => n.offsetParent !== null);
}

DIALOGS.forEach(({ el }) => {
  new MutationObserver(() => {
    if (!el.hidden && dialogOpener === null) {
      dialogOpener = document.activeElement;
      (dialogFocusables(el)[0] || el).focus();
    } else if (el.hidden && dialogOpener) {
      if (typeof dialogOpener.focus === 'function') dialogOpener.focus();
      dialogOpener = null;
    }
  }).observe(el, { attributes: true, attributeFilter: ['hidden'] });

  el.addEventListener('keydown', e => {
    if (e.key !== 'Tab') return;
    const f = dialogFocusables(el);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
});

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  const openDialog = DIALOGS.find(d => !d.el.hidden);
  if (openDialog) { openDialog.close(); return; }
  if (!accountMenu.hidden) { accountMenu.hidden = true; accountCircleBtn.focus(); return; }
  if (!notifPanel.hidden) { notifPanel.hidden = true; notifBellBtn.focus(); }
});

// Keep aria-expanded on the two topbar toggles in sync with their popup.
new MutationObserver(() => {
  accountCircleBtn.setAttribute('aria-expanded', String(!accountMenu.hidden));
}).observe(accountMenu, { attributes: true, attributeFilter: ['hidden'] });
new MutationObserver(() => {
  notifBellBtn.setAttribute('aria-expanded', String(!notifPanel.hidden));
}).observe(notifPanel, { attributes: true, attributeFilter: ['hidden'] });

// --- Phase 8B bootstrap ------------------------------------------------
// Explicit async gate: nothing routes until the real Supabase session has
// been restored AND the community/site caches have loaded at least once - 
// see this file's refreshDataCaches() header and CLAUDE.md's Phase 8B
// section. #bootstrap-loading (active by default in index.html) covers the
// screen the whole time so nothing ever renders a role view off an empty
// cache, and no stale pre-login screen flashes before the real route is
// known.
async function bootstrap() {
  // Roadmap Step 5 - read the invite-link query param (if any) exactly
  // once, before the very first route, and strip it from the URL
  // immediately (history.replaceState, inside consumeJoinIntentFromUrl)
  // so refreshing or re-sharing the resulting tab doesn't repeat the
  // prompt. Safe to call unconditionally, logged in or not - routeFromTop()
  // is what actually decides what to do with a held code once auth state is
  // known, including the logged-out case (showAuth() first, then this same
  // routeFromTop() logic re-runs after 'sitestock:logged-in').
  consumeJoinIntentFromUrl();
  // Stripe's return URLs carry ?billing=success|cancelled|returned - same one-shot
  // read-and-strip as the invite link; the Owner dashboard shows the message.
  consumeBillingReturnFromUrl();
  await Promise.all([authReady, refreshAppStatus()]);
  // Kill switch: bail before touching any of the data caches or routing.
  if (getAppStatus().killed) {
    showKillScreen(getAppStatus().message);
    return;
  }
  await Promise.all([loadAllProfiles(), refreshDataCaches()]);
  // Phase 8D.2 - covers session restore (a page load with an existing
  // Supabase session already in localStorage), which never fires
  // 'sitestock:logged-in' - that event only exists for the login FORM's own
  // success path. startRealtimeForSession() itself no-ops if there's no
  // authenticated user, so this is safe to call unconditionally here too.
  startRealtimeForSession();
  bootstrapLoadingView.classList.remove('active');
  routeFromTop();
  if (didJustConfirmEmail() && isAuthenticated()) showConfirmBanner();
}

// One-time "email confirmed - welcome" acknowledgement after a signup link
// lands the user in the app (auth.js didJustConfirmEmail). Auto-dismisses
// after 8s; the close button dismisses it sooner. Shown once per page load.
const confirmBanner = document.getElementById('confirm-banner');
const confirmBannerCloseBtn = document.getElementById('confirm-banner-close');
function hideConfirmBanner() {
  if (confirmBanner) confirmBanner.hidden = true;
}
function showConfirmBanner() {
  if (!confirmBanner) return;
  confirmBanner.hidden = false;
  setTimeout(hideConfirmBanner, 8000);
}
confirmBannerCloseBtn?.addEventListener('click', hideConfirmBanner);

// Lightweight freshness mechanism, kept as a fallback even after Phase
// 8D.2 added Realtime (see CLAUDE.md's Phase 8D.2 section) - Realtime
// itself reconnects and re-refreshes on its own after a dropped
// connection, but a focus-triggered refresh is still the thing that
// recovers correctness if the websocket never reconnects at all (a real
// possibility: corporate proxies, restrictive networks, browser
// extensions). Re-pulls community/site/order/notification data whenever
// the tab regains focus, so switching back after changes happened
// elsewhere doesn't leave a badly stale cache sitting around indefinitely.
// This does not itself force a re-render of every open view - see
// refreshDataCaches()'s header for why that's an accepted, documented
// limitation for owner/buyer/driver/site.js specifically.
window.addEventListener('focus', async () => {
  await refreshAppStatus();
  if (getAppStatus().killed) { showKillScreen(getAppStatus().message); return; }
  // Flag was cleared while the maintenance screen was up - reload into the
  // real app rather than trying to re-hydrate a torn-down session in place.
  if (killScreenShown) { location.reload(); return; }
  if (isAuthenticated()) refreshDataCaches();
});

bootstrap();
