// Phase 8B: real Supabase accounts, email + password. "Skip for now" has
// been removed entirely — see auth.js's header for why. Every submit is now
// a real network call, so both forms disable their submit button for the
// duration (prevents a double-submit firing two signUp/signIn calls before
// the first one resolves) and show a simple loading/error/success status,
// same .form-status element the rest of the app already uses.
import {
  createAccount, login, requestPasswordReset, completePasswordReset,
  inPasswordRecoveryContext, subscribeAuth,
  isMfaChallengePending, verifyMfaLogin, logout,
} from './auth.js';

const authTabs = document.getElementById('auth-tabs');
const loginForm = document.getElementById('login-form');
const registerForm = document.getElementById('register-form');
const loginStatus = document.getElementById('login-status');
const registerStatus = document.getElementById('register-status');
const loginSubmitBtn = document.getElementById('login-submit-btn');
const registerSubmitBtn = document.getElementById('register-submit-btn');
const registerRoleGroup = document.getElementById('register-role-group');
const registerTermsCheckbox = document.getElementById('register-terms-checkbox');
const forgotPasswordLink = document.getElementById('forgot-password-link');
const resetRequestForm = document.getElementById('reset-request-form');
const resetRequestBackBtn = document.getElementById('reset-request-back-btn');
const resetRequestStatus = document.getElementById('reset-request-status');
const resetRequestSubmitBtn = document.getElementById('reset-request-submit-btn');
const setNewPasswordForm = document.getElementById('set-new-password-form');
const newPasswordStatus = document.getElementById('new-password-status');
const newPasswordSubmitBtn = document.getElementById('new-password-submit-btn');
const mfaChallengeForm = document.getElementById('mfa-challenge-form');
const mfaChallengeInput = document.getElementById('mfa-challenge-input');
const mfaChallengeStatus = document.getElementById('mfa-challenge-status');
const mfaChallengeSubmitBtn = document.getElementById('mfa-challenge-submit-btn');
const mfaChallengeCancelBtn = document.getElementById('mfa-challenge-cancel-btn');

let selectedRegisterRole = null;

// "Create account" stays disabled until the Terms/Privacy box is ticked —
// index.html ships the button disabled, this keeps it in sync. The submit
// handler still re-checks (defence in depth), but the button is the real
// gate the user sees.
function syncRegisterSubmitEnabled() {
  registerSubmitBtn.disabled = !registerTermsCheckbox.checked;
}
registerTermsCheckbox.addEventListener('change', syncRegisterSubmitEnabled);

registerRoleGroup.addEventListener('click', e => {
  const btn = e.target.closest('.role-toggle-btn');
  if (!btn) return;
  selectedRegisterRole = btn.dataset.role;
  registerRoleGroup.querySelectorAll('.role-toggle-btn').forEach(b => {
    const on = b === btn;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
});

// Roadmap Step 5 — which of the four auth-view forms is visible. The two
// password-recovery forms replace the login/register tabs entirely while
// active (tabs hidden) rather than becoming a fifth tab — a recovery link
// is a one-shot flow the user didn't choose to navigate to, not a normal
// tab a person would click into.
function showAuthForm(which) {
  loginForm.hidden = which !== 'login';
  registerForm.hidden = which !== 'register';
  resetRequestForm.hidden = which !== 'reset-request';
  setNewPasswordForm.hidden = which !== 'set-new-password';
  mfaChallengeForm.hidden = which !== 'mfa-challenge';
  authTabs.hidden = which === 'reset-request' || which === 'set-new-password' || which === 'mfa-challenge';
}

// A pending 2FA challenge (from login() or a mid-challenge page refresh)
// replaces the login/register tabs with the code form — same "one-shot flow
// the user didn't navigate to" treatment as the password-recovery forms.
subscribeAuth(() => {
  if (isMfaChallengePending()) {
    mfaChallengeStatus.textContent = '';
    showAuthForm('mfa-challenge');
    mfaChallengeInput.focus();
  }
});

mfaChallengeForm.addEventListener('submit', async e => {
  e.preventDefault();
  mfaChallengeSubmitBtn.disabled = true;
  setStatus(mfaChallengeStatus, 'Verifying…', '');
  const result = await verifyMfaLogin(mfaChallengeInput.value);
  mfaChallengeSubmitBtn.disabled = false;
  if (result.error) {
    setStatus(mfaChallengeStatus, result.error, 'error');
    mfaChallengeInput.select();
    return;
  }
  mfaChallengeInput.value = '';
  loggedIn();
});

mfaChallengeCancelBtn.addEventListener('click', async () => {
  await logout();
  showAuthForm('login');
});

authTabs.addEventListener('click', e => {
  const btn = e.target.closest('.tab-btn');
  if (!btn) return;
  const tab = btn.dataset.authTab;
  authTabs.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
  showAuthForm(tab);
  loginStatus.textContent = '';
  registerStatus.textContent = '';
});

forgotPasswordLink.addEventListener('click', () => {
  resetRequestStatus.textContent = '';
  showAuthForm('reset-request');
});

resetRequestBackBtn.addEventListener('click', () => {
  showAuthForm('login');
});

function loggedIn() {
  window.dispatchEvent(new CustomEvent('sitestock:logged-in'));
}

function setStatus(el, text, kind) {
  el.textContent = text;
  el.className = kind ? `form-status ${kind}` : 'form-status';
}

loginForm.addEventListener('submit', async e => {
  e.preventDefault();
  const email = document.getElementById('login-email-input').value;
  const password = document.getElementById('login-password-input').value;

  loginSubmitBtn.disabled = true;
  setStatus(loginStatus, 'Logging in…', '');
  try {
    const result = await login(email, password);
    if (result.error) {
      setStatus(loginStatus, result.error, 'error');
      return;
    }
    if (result.mfaRequired) {
      // login() flipped isMfaChallengePending(); the subscribeAuth handler
      // above swaps in the code form. Just clear the login field state.
      setStatus(loginStatus, '', '');
      document.getElementById('login-password-input').value = '';
      return;
    }
    loggedIn();
  } catch (err) {
    setStatus(loginStatus, 'Could not reach the server. Check your connection and try again.', 'error');
  } finally {
    loginSubmitBtn.disabled = false;
  }
});

resetRequestForm.addEventListener('submit', async e => {
  e.preventDefault();
  const email = document.getElementById('reset-request-email-input').value;

  resetRequestSubmitBtn.disabled = true;
  setStatus(resetRequestStatus, 'Sending…', '');
  try {
    const result = await requestPasswordReset(email);
    // Always the same message regardless of `result` beyond a genuine
    // network/API-call failure — requestPasswordReset() itself never
    // reveals whether the email is actually registered, and this UI must
    // not undermine that by branching copy on anything else.
    if (result.error) {
      setStatus(resetRequestStatus, result.error, 'error');
      return;
    }
    setStatus(resetRequestStatus, 'If an account exists for that email, a reset link is on its way.', 'success');
  } catch (err) {
    setStatus(resetRequestStatus, 'Could not reach the server. Check your connection and try again.', 'error');
  } finally {
    resetRequestSubmitBtn.disabled = false;
  }
});

setNewPasswordForm.addEventListener('submit', async e => {
  e.preventDefault();
  const password = document.getElementById('new-password-input').value;
  const confirm = document.getElementById('new-password-confirm-input').value;

  if (password !== confirm) {
    setStatus(newPasswordStatus, "Passwords don't match.", 'error');
    return;
  }

  newPasswordSubmitBtn.disabled = true;
  setStatus(newPasswordStatus, 'Updating…', '');
  try {
    const result = await completePasswordReset(password);
    if (result.error) {
      setStatus(newPasswordStatus, result.error, 'error');
      return;
    }
    setStatus(newPasswordStatus, 'Your password has been updated.', 'success');
    // completePasswordReset() already cleared the recovery gate — this is
    // the same "I'm now properly authenticated, proceed" signal login/
    // register already dispatch, so main.js's existing routing takes over
    // exactly as it would after any other successful login.
    loggedIn();
  } catch (err) {
    setStatus(newPasswordStatus, 'Could not reach the server. Check your connection and try again.', 'error');
  } finally {
    newPasswordSubmitBtn.disabled = false;
  }
});

// Whenever auth state changes (including the very first check on page
// load), force the set-new-password form into view if we're in a genuine
// recovery context — this is what actually shows the right form when a
// recovery link is opened, independent of whatever tab was last active.
// main.js's own routeFromTop() is the thing that keeps the user ON the auth
// view at all while this is true (see auth.js's inPasswordRecoveryContext).
subscribeAuth(() => {
  if (inPasswordRecoveryContext()) {
    newPasswordStatus.textContent = '';
    showAuthForm('set-new-password');
  }
});

registerForm.addEventListener('submit', async e => {
  e.preventDefault();
  const email = document.getElementById('register-email-input').value;
  const password = document.getElementById('register-password-input').value;
  const confirm = document.getElementById('register-confirm-input').value;
  const displayName = document.getElementById('register-displayname-input').value;

  if (password !== confirm) {
    setStatus(registerStatus, "Passwords don't match.", 'error');
    return;
  }

  if (!selectedRegisterRole) {
    setStatus(registerStatus, "Please choose whether you're a worker, driver, buyer, or owner.", 'error');
    return;
  }

  if (!registerTermsCheckbox.checked) {
    setStatus(registerStatus, 'Please agree to the Terms of Service and Privacy Policy to continue.', 'error');
    return;
  }

  registerSubmitBtn.disabled = true;
  setStatus(registerStatus, 'Creating your account…', '');
  try {
    const result = await createAccount(email, password, displayName, selectedRegisterRole);
    if (result.error) {
      setStatus(registerStatus, result.error, 'error');
      return;
    }
    if (result.needsConfirmation) {
      // Cloud project with email confirmation on — no session yet. Send them
      // to the login form with an info (not error) message.
      showAuthForm('login');
      authTabs.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.authTab === 'login'));
      setStatus(loginStatus, result.message, 'success');
      registerStatus.textContent = '';
      return;
    }
    loggedIn();
  } catch (err) {
    setStatus(registerStatus, 'Could not reach the server. Check your connection and try again.', 'error');
  } finally {
    // Restore to the checkbox-gated state, not unconditionally enabled.
    syncRegisterSubmitEnabled();
  }
});
