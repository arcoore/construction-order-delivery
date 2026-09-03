import {
  getCommunities, subscribeCommunities,
  createCommunity, requestToJoinByCode, requestToJoin, membershipStatus,
  myCommunities, myPendingRequests, setActiveCommunityId,
  getPendingJoinCode, clearPendingJoinCode,
} from './community.js';
import { getLoggedInAccount, subscribeAuth } from './auth.js';
import { timeAgo } from './data.js';
import {
  getCurrentUserId, getCurrentDisplayName,
  subscribeIdentity,
} from './identity.js';

const accountStatusBtn = document.getElementById('account-status-btn');
const identityInput = document.getElementById('identity-name-input');
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

// Tracks which community joinCodeStatus's current message is actually
// about, whenever that message asserts a 'pending' state ("Request sent…"/
// "Already requested…"). render() re-validates this against the live
// membership status on every reactive call (Realtime, focus, view-entry —
// whatever triggered it) and clears the message the moment that community
// is no longer pending, instead of leaving a one-time action message frozen
// in the DOM after the real state has since moved on. null whenever
// joinCodeStatus holds anything else (an error, "Checking…", or an
// already-member message), so a later render never wrongly re-validates a
// stale id against an unrelated message.
let joinCodePendingCommunityId = null;

// The identity field is always read-only now — Phase 8B removed guest mode,
// so display name always comes from the real Supabase account and can only
// be set at signup (no editing UI exists for it yet).
function syncIdentityField() {
  identityInput.value = getCurrentDisplayName();
}
syncIdentityField();

function setStatus(el, text, kind) {
  el.textContent = text;
  el.className = kind ? `form-status ${kind}` : 'form-status';
}

createBtn.addEventListener('click', async () => {
  const userId = getCurrentUserId();
  const communityName = createInput.value.trim();
  if (!communityName) {
    setStatus(createStatus, 'Enter a community name.', 'error');
    return;
  }
  createBtn.disabled = true;
  setStatus(createStatus, 'Creating…', '');
  try {
    const result = await createCommunity(communityName, userId);
    if (result.error) {
      setStatus(createStatus, result.error, 'error');
      return;
    }
    createInput.value = '';
    setStatus(createStatus, '', '');
    enterCommunity(result.community.id);
  } finally {
    createBtn.disabled = false;
  }
});

joinCodeBtn.addEventListener('click', async () => {
  const userId = getCurrentUserId();
  const code = joinCodeInput.value.trim();
  if (!code) {
    joinCodePendingCommunityId = null;
    setStatus(joinCodeStatus, 'Enter an invite code.', 'error');
    return;
  }
  joinCodeBtn.disabled = true;
  joinCodePendingCommunityId = null;
  setStatus(joinCodeStatus, 'Checking…', '');
  try {
    const result = await requestToJoinByCode(code, userId);
    if (result.error) {
      setStatus(joinCodeStatus, result.error, 'error');
      return;
    }
    if (result.alreadyMember) {
      setStatus(joinCodeStatus, `You're already in "${result.community.name}".`, 'success');
      enterCommunity(result.community.id);
      return;
    }
    if (result.alreadyPending) {
      joinCodePendingCommunityId = result.community.id;
      setStatus(joinCodeStatus, `Already requested to join "${result.community.name}" — waiting for approval.`, '');
      return;
    }
    if (result.declined) {
      setStatus(joinCodeStatus, `Your earlier request to join "${result.community.name}" was declined. Ask the owner to invite you.`, 'error');
      return;
    }
    joinCodeInput.value = '';
    joinCodePendingCommunityId = result.community.id;
    setStatus(joinCodeStatus, `Request sent to "${result.community.name}" — waiting for the owner to approve it.`, 'success');
  } finally {
    joinCodeBtn.disabled = false;
  }
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

// Roadmap Step 5 — consumes a held invite-link code, if any, and pre-fills
// the existing manual-entry field with it. Exported and called explicitly
// by main.js's showCommunitiesView(), NOT wired into this view's own
// reactive render() — two real, sequential bugs were found wiring it that
// way during local verification:
//   1) this view's own subscribeCommunities(render) fires an immediate
//      render() the moment this module is first imported (see
//      subscribeCommunities's own "calls fn() immediately on subscribe"
//      contract), which happens BEFORE main.js's bootstrap() has even
//      called consumeJoinIntentFromUrl() yet — a one-time "already tried"
//      guard flag was being set permanently on that premature no-code call.
//   2) removing the guard flag fixed the pre-fill itself, but then
//      main.js's routeFromTop() — which decides whether to route to the
//      Companies screen at all based on getPendingJoinCode() being
//      truthy — lost the race against this same reactive render(), which
//      fires (and clears the code) during bootstrap's own cache-refresh
//      BEFORE routeFromTop() ever got to check it, so routing silently fell
//      through to the ordinary community picker instead.
// The fix for both: exactly one deliberate call site consumes (reads AND
// clears) the pending code — main.js's showCommunitiesView(), immediately
// before it calls refreshCommunitiesView() — never an incidental reactive
// render triggered by an unrelated cache refresh. This only ever pre-fills
// the field — the user still has to press the existing "Request to join"
// button themselves; see main.js/community.js for how the code got here.
export function applyPendingJoinIntent() {
  const code = getPendingJoinCode();
  if (!code) return;
  joinCodeInput.value = code.toUpperCase();
  clearPendingJoinCode();
}

function render() {
  renderAccountStatus();
  syncIdentityField();

  const userId = getCurrentUserId();

  // Re-validate any "waiting for approval" message still on screen against
  // the actual current membership status, every time this reactive render
  // runs (Realtime, window focus, or view-entry — whichever triggered it).
  // A one-time action message is otherwise never revisited once written, so
  // it can end up frozen on screen long after the real status has already
  // moved to approved/declined elsewhere — exactly the contradiction found
  // live (the community correctly appeared under "Your communities" while
  // this message still said "waiting for the owner to approve it").
  if (joinCodePendingCommunityId && membershipStatus(joinCodePendingCommunityId, userId) !== 'pending') {
    joinCodePendingCommunityId = null;
    setStatus(joinCodeStatus, '', '');
  }

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
    emptyMessage = 'No communities exist yet — create the first one above.';
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
      } else if (status === 'declined') {
        actionHtml = `<span class="community-status-declined">Request declined</span>`;
      } else {
        actionHtml = `<button class="btn btn-secondary" data-request="${c.id}">Request to join</button>`;
      }
      return `
        <div class="community-card">
          <div class="community-card-info">
            <strong>${c.name}</strong>
          </div>
          ${actionHtml}
        </div>
      `;
    }).join('');

  browseList.querySelectorAll('[data-enter]').forEach(btn => {
    btn.addEventListener('click', () => enterCommunity(btn.dataset.enter));
  });
  browseList.querySelectorAll('[data-request]').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Requesting…';
      const result = await requestToJoin(btn.dataset.request, getCurrentUserId());
      if (result && (result.error || result.declined)) {
        alert(result.declined
          ? 'Your earlier request to join was declined. Ask the owner to invite you.'
          : result.error);
        btn.disabled = false;
        btn.textContent = 'Request to join';
        return;
      }
      // On success the community.js write already fired notify(), which
      // re-runs render() and replaces this button with the "Requested"
      // pending state — no manual re-enable needed on the happy path.
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
  setStatus(createStatus, '', '');
  setStatus(joinCodeStatus, '', '');
  joinCodePendingCommunityId = null;
  render();
}
