import {
  getCommunities, subscribeCommunities,
  createCommunity, requestToJoinByCode, requestToJoin, membershipStatus,
  myCommunities, myPendingRequests, setActiveCommunityId,
} from './community.js';
import { getLoggedInAccount, subscribeAuth } from './auth.js';
import { timeAgo } from './data.js';
import {
  getCurrentUserId, getCurrentDisplayName, isGuest, getGuestName, setGuestName,
  resolveDisplayName, subscribeIdentity,
} from './identity.js';

const accountStatusBtn = document.getElementById('account-status-btn');
const identityInput = document.getElementById('identity-name-input');
const identityHint = document.getElementById('identity-name-hint');
const myCommunitiesPanel = document.getElementById('my-communities-panel');
const myCommunitiesList = document.getElementById('my-communities-list');
const pendingRequestsPanel = document.getElementById('pending-requests-panel');
const pendingRequestsList = document.getElementById('pending-requests-list');
const createPanel = document.getElementById('create-community-panel');
const createInput = document.getElementById('create-community-input');
const createBtn = document.getElementById('create-community-btn');
const createStatus = document.getElementById('create-community-status');
const joinCodePanel = document.getElementById('join-code-panel');
const joinCodeInput = document.getElementById('join-code-input');
const joinCodeBtn = document.getElementById('join-code-btn');
const joinCodeStatus = document.getElementById('join-code-status');
const browsePanel = document.getElementById('browse-communities-panel');
const browseList = document.getElementById('browse-communities-list');
const browseSearchInput = document.getElementById('browse-communities-search');

browseSearchInput.addEventListener('input', render);

function syncIdentityField() {
  if (isGuest()) {
    identityInput.value = getGuestName();
    identityInput.readOnly = false;
    identityHint.hidden = true;
  } else {
    identityInput.value = getCurrentDisplayName();
    identityInput.readOnly = true;
    identityHint.hidden = false;
  }
}
syncIdentityField();

identityInput.addEventListener('input', () => {
  if (!isGuest()) return; // read-only for logged-in accounts, guarded here too
  setGuestName(identityInput.value);
  render();
});

createBtn.addEventListener('click', () => {
  const userId = getCurrentUserId();
  const displayName = getCurrentDisplayName();
  const communityName = createInput.value.trim();
  if (!displayName) {
    createStatus.textContent = 'Enter your name above first.';
    createStatus.className = 'form-status error';
    return;
  }
  if (!communityName) {
    createStatus.textContent = 'Enter a community name.';
    createStatus.className = 'form-status error';
    return;
  }
  const community = createCommunity(communityName, userId);
  createInput.value = '';
  createStatus.textContent = '';
  enterCommunity(community.id);
});

joinCodeBtn.addEventListener('click', () => {
  const userId = getCurrentUserId();
  const displayName = getCurrentDisplayName();
  const code = joinCodeInput.value.trim();
  if (!displayName) {
    joinCodeStatus.textContent = 'Enter your name above first.';
    joinCodeStatus.className = 'form-status error';
    return;
  }
  if (!code) {
    joinCodeStatus.textContent = 'Enter an invite code.';
    joinCodeStatus.className = 'form-status error';
    return;
  }
  const result = requestToJoinByCode(code, userId);
  if (result.error) {
    joinCodeStatus.textContent = result.error;
    joinCodeStatus.className = 'form-status error';
    return;
  }
  if (result.alreadyMember) {
    joinCodeStatus.textContent = `You're already in "${result.community.name}".`;
    joinCodeStatus.className = 'form-status success';
    enterCommunity(result.community.id);
    return;
  }
  if (result.alreadyPending) {
    joinCodeStatus.textContent = `Already requested to join "${result.community.name}" — waiting for approval.`;
    joinCodeStatus.className = 'form-status';
    return;
  }
  joinCodeInput.value = '';
  joinCodeStatus.textContent = `Request sent to "${result.community.name}" — waiting for the owner to approve it.`;
  joinCodeStatus.className = 'form-status success';
});

function enterCommunity(id) {
  setActiveCommunityId(id);
  window.dispatchEvent(new CustomEvent('sitestock:enter-community', { detail: { id } }));
}

function renderAccountStatus() {
  accountStatusBtn.textContent = getLoggedInAccount() ? 'Show profile' : 'Log in';
}

accountStatusBtn.addEventListener('click', () => {
  if (getLoggedInAccount()) {
    window.dispatchEvent(new CustomEvent('sitestock:show-profile'));
  } else {
    window.dispatchEvent(new CustomEvent('sitestock:go-to-auth'));
  }
});

function render() {
  renderAccountStatus();
  syncIdentityField();

  const userId = getCurrentUserId();

  const mine = myCommunities(userId);
  myCommunitiesPanel.hidden = mine.length === 0;
  myCommunitiesList.innerHTML = mine.map(c => `
    <div class="community-card">
      <div class="community-card-info">
        <strong>${c.name}</strong>
        <span>Code: ${c.code}</span>
      </div>
      <button class="btn btn-primary" data-enter="${c.id}">Enter</button>
    </div>
  `).join('');
  myCommunitiesList.querySelectorAll('[data-enter]').forEach(btn => {
    btn.addEventListener('click', () => enterCommunity(btn.dataset.enter));
  });

  const pending = myPendingRequests(userId);
  pendingRequestsPanel.hidden = pending.length === 0;
  pendingRequestsList.innerHTML = pending.map(r => {
    const community = getCommunities().find(c => c.id === r.communityId);
    return `
      <div class="community-card">
        <div class="community-card-info">
          <strong>${community ? community.name : 'Unknown community'}</strong>
          <span>Requested ${timeAgo(r.requestedAt)} &middot; waiting for approval</span>
        </div>
      </div>
    `;
  }).join('');

  createPanel.hidden = false;
  joinCodePanel.hidden = false;
  browsePanel.hidden = false;

  const all = getCommunities().sort((a, b) => b.createdAt - a.createdAt);
  const query = browseSearchInput.value.trim().toLowerCase();
  const visible = query ? all.filter(c => c.name.toLowerCase().includes(query)) : all;

  let emptyMessage = null;
  if (all.length === 0) {
    emptyMessage = 'No communities exist in this browser yet — create the first one above.';
  } else if (visible.length === 0) {
    emptyMessage = `No communities match "${browseSearchInput.value.trim()}".`;
  }

  browseList.innerHTML = emptyMessage
    ? `<p class="empty-hint">${emptyMessage}</p>`
    : visible.map(c => {
      const status = membershipStatus(c.id, userId);
      let actionHtml;
      if (status === 'owner' || status === 'approved') {
        actionHtml = `<button class="btn btn-primary" data-enter="${c.id}">Enter</button>`;
      } else if (status === 'pending') {
        actionHtml = `<span class="community-status-pending">Requested</span>`;
      } else {
        actionHtml = `<button class="btn btn-secondary" data-request="${c.id}">Request to join</button>`;
      }
      return `
        <div class="community-card">
          <div class="community-card-info">
            <strong>${c.name}</strong>
            <span>Owner: ${resolveDisplayName(c.ownerId)}</span>
          </div>
          ${actionHtml}
        </div>
      `;
    }).join('');

  browseList.querySelectorAll('[data-enter]').forEach(btn => {
    btn.addEventListener('click', () => enterCommunity(btn.dataset.enter));
  });
  browseList.querySelectorAll('[data-request]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!getCurrentDisplayName()) {
        identityInput.focus();
        return;
      }
      requestToJoin(btn.dataset.request, getCurrentUserId());
    });
  });
}

subscribeCommunities(render);
subscribeAuth(render);
subscribeIdentity(render);

// Clears leftover status text (e.g. "Request sent…") left behind by a
// previous visit/account before this screen is shown again — those
// messages are meant as one-time feedback for the action that produced
// them, not a persistent label.
export function refreshCommunitiesView() {
  createStatus.textContent = '';
  createStatus.className = 'form-status';
  joinCodeStatus.textContent = '';
  joinCodeStatus.className = 'form-status';
  render();
}
