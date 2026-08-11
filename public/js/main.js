import './authView.js';
import './communityView.js';
import { refreshWorkerView } from './site.js';
import { refreshOwnerView } from './owner.js';
import { refreshDriverView } from './driver.js';
import { isAuthenticated, getLoggedInAccount, logout as authLogout } from './auth.js';
import { getInitials } from './data.js';
import {
  getActiveCommunityId, getActiveCommunity, getIdentityName, setIdentityName,
  isApprovedMember, setActiveCommunityId, membershipStatus, myCommunities,
  getActiveRole, setActiveRole, eligibleRoles, resolveEntryRole, subscribeCommunities,
  getCommunities, findUnseenGrantFor, markGrantSeen,
} from './community.js';

const authView = document.getElementById('auth-view');
const communityView = document.getElementById('community-view');
const communitiesView = document.getElementById('communities-view');
const profileView = document.getElementById('profile-view');
const roleSelectView = document.getElementById('role-select-view');
const workerView = document.getElementById('worker-view');
const ownerView = document.getElementById('owner-view');
const driverView = document.getElementById('driver-view');
const sessionBar = document.getElementById('session-bar');
const sessionLabel = document.getElementById('session-label');
const communityIndicator = document.getElementById('community-indicator');
const communitiesPillBtn = document.getElementById('communities-pill-btn');
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

const ALL_VIEWS = [authView, communityView, communitiesView, profileView, roleSelectView, workerView, ownerView, driverView];

const ROLE_META = {
  owner: { icon: '👑', label: 'Owner', desc: 'Approve worker requests and community join requests' },
  worker: { icon: '🧑‍🔧', label: 'Worker', desc: 'Search for materials and place order requests' },
  driver: { icon: '🚚', label: 'Driver', desc: 'Pick up approved orders and deliver them' },
};

function showOnly(view) {
  ALL_VIEWS.forEach(v => v.classList.toggle('active', v === view));
}

function updateTopRightPills() {
  profilePillBtn.hidden = false;
  profilePillBtn.textContent = getLoggedInAccount() ? 'Show profile' : 'Log in';
  communitiesPillBtn.hidden = false;
}

function showAuth() {
  showOnly(authView);
  sessionBar.hidden = true;
  profilePillBtn.hidden = true;
  communitiesPillBtn.hidden = true;
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
}

function showProfile() {
  const account = getLoggedInAccount();
  const name = getIdentityName();

  const memberships = name ? myCommunities(name).map(c => ({
    name: c.name,
    role: membershipStatus(c.id, name) === 'owner' ? 'Owner' : 'Member',
  })) : [];

  profileDetails.innerHTML = `
    <div class="profile-field">
      <span class="profile-label">Display name</span>
      <span class="profile-value">${name || '—'}</span>
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
            </div>
          `).join('')}
      </div>
    </div>
    <button type="button" class="btn btn-secondary btn-block" id="profile-logout-btn">Log out</button>
  `;

  document.getElementById('profile-logout-btn').addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('sitestock:logout'));
  });

  showOnly(profileView);
  sessionBar.hidden = true;
  updateTopRightPills();
}

function showRoleSelect() {
  const community = getActiveCommunity();
  const name = getIdentityName();
  if (!community || !name || !isApprovedMember(community.id, name)) {
    setActiveCommunityId(null);
    showCommunityPicker();
    return;
  }

  roleSelectName.textContent = name;
  roleSelectCommunityName.textContent = community.name;

  const roles = eligibleRoles(community.id, name);
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
  communityIndicator.textContent = `${community.name} — ${name}`;
  communityCircleBtn.textContent = getInitials(community.name);
  updateTopRightPills();
}

function showRoleView() {
  const community = getActiveCommunity();
  const name = getIdentityName();
  const role = getActiveRole();

  if (!community || !name || !isApprovedMember(community.id, name)) {
    setActiveCommunityId(null);
    showCommunityPicker();
    return;
  }

  const roles = eligibleRoles(community.id, name);
  if (!role || !roles.includes(role)) {
    showRoleSelect();
    return;
  }

  const account = getLoggedInAccount();

  communityIndicator.textContent = `${community.name} — ${name}`;
  sessionBar.hidden = false;
  menuSwitchRoleBtn.hidden = !!(account && account.defaultRole);
  sessionLabel.textContent = `Logged in as ${ROLE_META[role].label}`;
  communityCircleBtn.textContent = getInitials(community.name);
  updateTopRightPills();

  if (role === 'worker') {
    showOnly(workerView);
    refreshWorkerView();
  } else if (role === 'owner') {
    showOnly(ownerView);
    refreshOwnerView();
  } else if (role === 'driver') {
    showOnly(driverView);
    refreshDriverView();
  }
}

// Resolves where someone lands in a community with no prompt when possible:
// their account already answered "worker/driver/owner" at signup, so we can
// go straight there (owner only ever applies if they actually are one).
// Falls back to the manual picker for skipped sessions / accounts made
// before this existed.
function enterCommunityFlow() {
  const community = getActiveCommunity();
  const name = getIdentityName();
  if (!community || !name || !isApprovedMember(community.id, name)) {
    setActiveCommunityId(null);
    showCommunityPicker();
    return;
  }

  const account = getLoggedInAccount();
  if (account && account.defaultRole) {
    const role = resolveEntryRole(community.id, name, account.defaultRole);
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
  const name = getIdentityName();
  if (!name || !isAuthenticated()) return;
  const grant = findUnseenGrantFor(name);
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
  accountMenu.hidden = !accountMenu.hidden;
});

document.addEventListener('click', () => {
  accountMenu.hidden = true;
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
  setActiveCommunityId(null);
  setIdentityName('');
  authLogout();
  showAuth();
});

window.addEventListener('sitestock:go-to-auth', () => showAuth());
window.addEventListener('sitestock:show-profile', () => showProfile());

subscribeCommunities(() => {
  checkForNewOwnerGrant();
  if (!getActiveCommunityId()) return;
  const community = getActiveCommunity();
  const name = getIdentityName();
  if (!community || !isApprovedMember(community.id, name)) {
    showCommunityPicker();
  }
});

routeFromTop();
