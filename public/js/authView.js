// Phase 8B: real Supabase accounts, email + password. "Skip for now" has
// been removed entirely - see auth.js's header for why. Every submit is now
// a real network call, so both forms disable their submit button for the
// duration (prevents a double-submit firing two signUp/signIn calls before
// the first one resolves) and show a simple loading/error/success status,
// same .form-status element the rest of the app already uses.
import {
  createAccount, login, requestPasswordReset, completePasswordReset,
  inPasswordRecoveryContext, subscribeAuth, resendConfirmation,
  isMfaChallengePending, verifyMfaLogin, logout, isAuthenticated,
  signInWithProvider, getEnabledOAuthProviders,
} from './auth.js';
import { isPasswordPwned } from './pwnedPassword.js';

const authView = document.getElementById('auth-view');
const authIntro = document.getElementById('auth-intro');
const authTabs = document.getElementById('auth-tabs');
const loginForm = document.getElementById('login-form');
const registerForm = document.getElementById('register-form');
const loginStatus = document.getElementById('login-status');
const registerStatus = document.getElementById('register-status');
const loginSubmitBtn = document.getElementById('login-submit-btn');
const registerSubmitBtn = document.getElementById('register-submit-btn');
const registerRoleGroup = document.getElementById('register-role-group');
const registerTermsCheckbox = document.getElementById('register-terms-checkbox');
const pwInput = document.getElementById('register-password-input');
const pwConfirmInput = document.getElementById('register-confirm-input');
const pwChecklist = document.getElementById('pw-checklist');
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
const checkEmailPanel = document.getElementById('check-email-panel');
const checkEmailAddress = document.getElementById('check-email-address');
const checkEmailResendBtn = document.getElementById('check-email-resend-btn');
const checkEmailLoginBtn = document.getElementById('check-email-login-btn');
const checkEmailStatus = document.getElementById('check-email-status');
const oauthBlock = document.getElementById('oauth-block');
const oauthStatus = document.getElementById('oauth-status');

// --- Resend-email cooldown ---------------------------------------------
// A visible 60s countdown on the "Resend the email" button. This is the
// UX layer over GoTrue's own server-side per-address limit (config.toml
// [auth.email] max_frequency = "60s", GOTRUE_SMTP_MAX_FREQUENCY) - it stops
// the button being mashed and gives a clear "wait Ns" instead of a silent
// failure. One global "until" timestamp in localStorage (not per-address) so
// a page refresh mid-cooldown doesn't reset it. Also started right after
// sign-up, since the confirmation email just went out.
const RESEND_COOLDOWN_MS = 60_000;
const RESEND_UNTIL_KEY = 'sitestock_resend_until';
const checkEmailResendLabel = checkEmailResendBtn ? checkEmailResendBtn.textContent : 'Resend the email';
let resendTimer = null;

function resendCooldownRemaining() {
  try {
    return Math.max(0, Number(localStorage.getItem(RESEND_UNTIL_KEY) || 0) - Date.now());
  } catch {
    return 0;
  }
}
function startResendCooldown() {
  try { localStorage.setItem(RESEND_UNTIL_KEY, String(Date.now() + RESEND_COOLDOWN_MS)); } catch { /* storage blocked */ }
  tickResendCooldown();
}
function tickResendCooldown() {
  if (!checkEmailResendBtn) return;
  clearTimeout(resendTimer);
  const remaining = resendCooldownRemaining();
  if (remaining <= 0) {
    checkEmailResendBtn.disabled = false;
    checkEmailResendBtn.textContent = checkEmailResendLabel;
    return;
  }
  checkEmailResendBtn.disabled = true;
  checkEmailResendBtn.textContent = `Resend available in ${Math.ceil(remaining / 1000)}s`;
  resendTimer = setTimeout(tickResendCooldown, 1000);
}

// --- Social sign-in (Google / Microsoft / Apple) ------------------------
// A button shows only when the provider is BOTH listed in
// window.SITESTOCK_OAUTH_PROVIDERS (env.js) AND reported enabled by GoTrue's
// /settings endpoint (getEnabledOAuthProviders). Both are [] / all-false by
// default, so nothing shows and nothing changes for anyone. The double gate
// means a button can never appear for a provider that would just error.
// oauthProvidersShown tracks whether any button is live, so showAuthForm
// knows whether to reveal the block on the login/register forms.
const OAUTH_WANTED = Array.isArray(window.SITESTOCK_OAUTH_PROVIDERS)
  ? window.SITESTOCK_OAUTH_PROVIDERS
  : [];
let oauthProvidersShown = false;

async function wireSocialSignIn() {
  if (!OAUTH_WANTED.length) return;
  const enabled = await getEnabledOAuthProviders();
  const live = OAUTH_WANTED.filter(p => enabled.includes(p));
  if (!live.length) return;

  oauthBlock.querySelectorAll('.btn-oauth').forEach(btn => {
    if (!live.includes(btn.dataset.oauth)) return;
    btn.hidden = false;
    btn.addEventListener('click', async () => {
      oauthBlock.querySelectorAll('.btn-oauth').forEach(b => { b.disabled = true; });
      setStatus(oauthStatus, 'Taking you to your provider…', '');
      try {
        const result = await signInWithProvider(btn.dataset.oauth);
        // On success the browser is already navigating away; only an error
        // that happened before the redirect ever lands back here.
        if (result && result.error) {
          setStatus(oauthStatus, result.error, 'error');
          oauthBlock.querySelectorAll('.btn-oauth').forEach(b => { b.disabled = false; });
        }
      } catch (err) {
        setStatus(oauthStatus, 'Could not start sign-in. Check your connection and try again.', 'error');
        oauthBlock.querySelectorAll('.btn-oauth').forEach(b => { b.disabled = false; });
      }
    });
  });

  oauthProvidersShown = true;
  // The initial auth view is login/register (one-shot flows are reached only
  // by a click or a recovery link, where showAuthForm hides this again).
  // Nothing calls showAuthForm on a plain load, so reveal it here.
  if (!loginForm.hidden || !registerForm.hidden) oauthBlock.hidden = false;
}
wireSocialSignIn();

let selectedRegisterRole = null;
let pendingConfirmEmail = null;

// --- Show/hide toggle on every password field in the auth view -----------
authView.querySelectorAll('input[type="password"]').forEach(input => {
  if (input.closest('.pw-field')) return;
  const wrap = document.createElement('div');
  wrap.className = 'pw-field';
  input.replaceWith(wrap);
  wrap.appendChild(input);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pw-toggle';
  btn.setAttribute('aria-label', 'Show password');
  btn.setAttribute('aria-pressed', 'false');
  btn.textContent = 'Show';
  btn.addEventListener('click', () => {
    const reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    btn.textContent = reveal ? 'Hide' : 'Show';
    btn.setAttribute('aria-label', reveal ? 'Hide password' : 'Show password');
    btn.setAttribute('aria-pressed', String(reveal));
  });
  wrap.appendChild(btn);
});

// --- Cloudflare Turnstile CAPTCHA (login / register / reset / resend) ----
// OFF unless window.SITESTOCK_TURNSTILE_KEY is set (env.js) AND [auth.captcha]
// is enabled in supabase/config.toml - that is the current default, and in
// that state every helper below is a no-op and NO third-party script loads.
//
// When ON: challenges.cloudflare.com/turnstile/v0/api.js is injected once
// (allowed by the page CSP's script-src + frame-src), a widget is rendered
// into each .captcha-slot, and the freshest token per form is kept in the
// map. Turnstile tokens are single-use and expire after ~5 minutes, so the
// widget is reset after every submit that reached the network.
const TURNSTILE_SITE_KEY = window.SITESTOCK_TURNSTILE_KEY || '';
const captchaOn = !!TURNSTILE_SITE_KEY;
const captchaSlots = new Map(); // formKey -> { el, widgetId, token }

if (captchaOn) {
  authView.querySelectorAll('.captcha-slot').forEach(el => {
    captchaSlots.set(el.dataset.captchaForm, { el, widgetId: null, token: null });
  });
  window.__sitestockTurnstileReady = () => {
    for (const slot of captchaSlots.values()) {
      if (slot.widgetId !== null || !window.turnstile) continue;
      slot.widgetId = window.turnstile.render(slot.el, {
        sitekey: TURNSTILE_SITE_KEY,
        callback: t => { slot.token = t; },
        'expired-callback': () => { slot.token = null; },
        'error-callback': () => { slot.token = null; },
      });
    }
  };
  const s = document.createElement('script');
  s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=__sitestockTurnstileReady&render=explicit';
  s.async = true;
  s.defer = true;
  document.head.appendChild(s);
}

function captchaToken(formKey) {
  if (!captchaOn) return '';
  return (captchaSlots.get(formKey) || {}).token || '';
}

// True only when captcha is on for this form and the user hasn't solved it.
function captchaMissing(formKey) {
  return captchaOn && !captchaToken(formKey);
}

// Consume-and-refresh: call right after a submit that used the token so the
// next attempt gets a fresh, unused one.
function resetCaptcha(formKey) {
  if (!captchaOn) return;
  const slot = captchaSlots.get(formKey);
  if (slot && slot.widgetId !== null && window.turnstile) {
    window.turnstile.reset(slot.widgetId);
    slot.token = null;
  }
}

// --- Live password requirements on the register form -----------------
// Length + "not in a known breach" + match, checked as the user types, so
// the "Create account" button only enables once the password would actually
// be accepted - not after a failed submit. The breach check is the same
// k-anonymous Have-I-Been-Pwned lookup createAccount() runs; here it's
// debounced and fails open (a network blip shows the rule as met and the
// submit handler still re-checks server-side).
const PW_MIN_LENGTH = 10;
let pwBreachState = 'idle'; // idle | checking | ok | pwned | unknown
let pwBreachTimer = null;
let pwBreachSeq = 0;

function setPwRule(rule, cls, stateWord) {
  const li = pwChecklist && pwChecklist.querySelector(`[data-rule="${rule}"]`);
  if (!li) return;
  li.classList.remove('met', 'fail', 'checking');
  if (cls) li.classList.add(cls);
  const stateEl = li.querySelector('.pw-rule-state');
  if (stateEl) stateEl.textContent = ` — ${stateWord}`;
}

function refreshPwChecklist() {
  if (!pwInput) return;
  const pw = pwInput.value;
  const confirm = pwConfirmInput ? pwConfirmInput.value : '';

  const lengthOk = pw.length >= PW_MIN_LENGTH;
  setPwRule('length', lengthOk ? 'met' : '', lengthOk ? 'met' : 'not yet met');

  const matchOk = !!pw && !!confirm && pw === confirm;
  setPwRule('match', matchOk ? 'met' : '', matchOk ? 'met' : 'not yet met');

  if (pwBreachState === 'checking') setPwRule('breach', 'checking', 'checking…');
  else if (pwBreachState === 'pwned') setPwRule('breach', 'fail', 'found in a known breach - pick another');
  else if (pwBreachState === 'ok' || pwBreachState === 'unknown') setPwRule('breach', 'met', 'met');
  else setPwRule('breach', '', 'not yet met');

  syncRegisterSubmitEnabled();
}

function schedulePwBreachCheck() {
  clearTimeout(pwBreachTimer);
  const pw = pwInput ? pwInput.value : '';
  if (pw.length < PW_MIN_LENGTH) { pwBreachState = 'idle'; refreshPwChecklist(); return; }
  pwBreachState = 'checking';
  refreshPwChecklist();
  const seq = ++pwBreachSeq;
  pwBreachTimer = setTimeout(async () => {
    const result = await isPasswordPwned(pw);
    if (seq !== pwBreachSeq || pwInput.value !== pw) return; // superseded by newer input
    pwBreachState = !result.checked ? 'unknown' : (result.pwned ? 'pwned' : 'ok');
    refreshPwChecklist();
  }, 550);
}

pwInput?.addEventListener('input', () => { schedulePwBreachCheck(); refreshPwChecklist(); });
pwConfirmInput?.addEventListener('input', refreshPwChecklist);

// "Create account" stays disabled until the Terms/Privacy box is ticked AND
// the password meets every rule above - index.html ships the button
// disabled, this keeps it in sync. The submit handler still re-checks
// (defence in depth), but the button is the real gate the user sees.
function syncRegisterSubmitEnabled() {
  const pw = pwInput ? pwInput.value : '';
  const confirm = pwConfirmInput ? pwConfirmInput.value : '';
  const passwordReady =
    pw.length >= PW_MIN_LENGTH &&
    confirm.length > 0 && pw === confirm &&
    (pwBreachState === 'ok' || pwBreachState === 'unknown');
  const disabled = !registerTermsCheckbox.checked || !passwordReady;
  registerSubmitBtn.disabled = disabled;
  const sticky = document.getElementById('sticky-cta-btn');
  if (sticky) sticky.disabled = disabled;
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

// Roadmap Step 5 - which of the four auth-view forms is visible. The two
// password-recovery forms replace the login/register tabs entirely while
// active (tabs hidden) rather than becoming a fifth tab - a recovery link
// is a one-shot flow the user didn't choose to navigate to, not a normal
// tab a person would click into.
function showAuthForm(which) {
  loginForm.hidden = which !== 'login';
  registerForm.hidden = which !== 'register';
  resetRequestForm.hidden = which !== 'reset-request';
  setNewPasswordForm.hidden = which !== 'set-new-password';
  mfaChallengeForm.hidden = which !== 'mfa-challenge';
  checkEmailPanel.hidden = which !== 'check-email';
  // Restore the resend countdown when this screen comes into view (e.g. a
  // page refresh mid-cooldown).
  if (which === 'check-email') tickResendCooldown();
  // The login/register tabs and the "Log in to SiteStock" intro only make
  // sense on those two forms - the rest are one-shot flows with their own
  // heading (password recovery, 2FA, confirm-your-email). The social sign-in
  // block follows the tabs, and is only ever shown when a provider is
  // actually enabled.
  authTabs.hidden = which !== 'login' && which !== 'register';
  authIntro.hidden = authTabs.hidden;
  oauthBlock.hidden = authTabs.hidden || !oauthProvidersShown;
  // Re-sync the password checklist to whatever's already in the fields (they
  // keep their value across a tab switch) so it never shows stale state.
  if (which === 'register') refreshPwChecklist();
  setStickyCta(which === 'register');
}

// --- Sticky mobile CTA (index.html #sticky-cta) --------------------
// On a narrow screen the "Create account" button sits well below the fold
// on the register form, so a fixed copy of it stays in reach at the bottom.
// CSS keeps it off desktop and off while the cookie notice is up; this just
// toggles visibility (register form only) and mirrors the real button's
// disabled state. The click forwards to the real submit button.
const stickyCta = document.getElementById('sticky-cta');
const stickyCtaBtn = document.getElementById('sticky-cta-btn');
function setStickyCta(show) {
  if (!stickyCta) return;
  stickyCta.hidden = !show;
  document.body.classList.toggle('sticky-cta-open', show);
  if (show) syncRegisterSubmitEnabled();
}
stickyCtaBtn?.addEventListener('click', () => {
  registerSubmitBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
  if (!registerSubmitBtn.disabled) registerSubmitBtn.click();
});
subscribeAuth(() => { if (isAuthenticated()) setStickyCta(false); });

// A pending 2FA challenge (from login() or a mid-challenge page refresh)
// replaces the login/register tabs with the code form - same "one-shot flow
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
  activateAuthTab(tab);
});

// Reflect the selected tab both visually (.active) and to assistive tech
// (aria-current) - the two must always move together.
function markAuthTab(tab) {
  authTabs.querySelectorAll('.tab-btn').forEach(b => {
    const on = b.dataset.authTab === tab;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'true');
    else b.removeAttribute('aria-current');
  });
}

function activateAuthTab(tab) {
  markAuthTab(tab);
  showAuthForm(tab);
  loginStatus.textContent = '';
  registerStatus.textContent = '';
}

// "Create an account" link in the intro copy - same as tapping the Create
// account tab, just more discoverable above the fold.
document.getElementById('auth-intro-register-btn')?.addEventListener('click', () => {
  activateAuthTab('register');
  document.getElementById('register-email-input')?.focus();
});

forgotPasswordLink.addEventListener('click', () => {
  resetRequestStatus.textContent = '';
  showAuthForm('reset-request');
});

resetRequestBackBtn.addEventListener('click', () => {
  showAuthForm('login');
});

checkEmailLoginBtn.addEventListener('click', () => {
  markAuthTab('login');
  showAuthForm('login');
});

checkEmailResendBtn.addEventListener('click', async () => {
  if (!pendingConfirmEmail) return;
  if (resendCooldownRemaining() > 0) {
    // Shouldn't be reachable (button is disabled) - belt and braces.
    tickResendCooldown();
    return;
  }
  if (captchaMissing('resend')) {
    setStatus(checkEmailStatus, 'Please complete the "I\'m not a robot" check first.', 'error');
    return;
  }
  checkEmailResendBtn.disabled = true;
  setStatus(checkEmailStatus, 'Sending…', '');
  let startCooldown = false;
  try {
    const result = await resendConfirmation(pendingConfirmEmail, captchaToken('resend'));
    if (result.error) {
      setStatus(checkEmailStatus, result.error, 'error');
      // Anything except a can't-reach-the-server failure means the request
      // landed (sent, or refused as too-soon) - hold the button for 60s.
      startCooldown = !result.networkError;
      return;
    }
    setStatus(checkEmailStatus, `Sent again to ${pendingConfirmEmail}. Check your inbox, and your spam folder.`, 'success');
    startCooldown = true;
  } catch (err) {
    setStatus(checkEmailStatus, 'Could not reach the server. Check your connection and try again.', 'error');
  } finally {
    resetCaptcha('resend');
    if (startCooldown) startResendCooldown();
    else checkEmailResendBtn.disabled = false;
  }
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

  if (captchaMissing('login')) {
    setStatus(loginStatus, 'Please complete the "I\'m not a robot" check first.', 'error');
    return;
  }

  loginSubmitBtn.disabled = true;
  setStatus(loginStatus, 'Logging in…', '');
  try {
    const result = await login(email, password, captchaToken('login'));
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
    resetCaptcha('login');
  }
});

resetRequestForm.addEventListener('submit', async e => {
  e.preventDefault();
  const email = document.getElementById('reset-request-email-input').value;

  if (captchaMissing('reset-request')) {
    setStatus(resetRequestStatus, 'Please complete the "I\'m not a robot" check first.', 'error');
    return;
  }

  resetRequestSubmitBtn.disabled = true;
  setStatus(resetRequestStatus, 'Sending…', '');
  try {
    const result = await requestPasswordReset(email, captchaToken('reset-request'));
    // Always the same message regardless of `result` beyond a genuine
    // network/API-call failure - requestPasswordReset() itself never
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
    resetCaptcha('reset-request');
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
    // completePasswordReset() already cleared the recovery gate - this is
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
// recovery context - this is what actually shows the right form when a
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
    setStatus(registerStatus, 'Please confirm you are 18 or over and agree to the Terms of Service, EULA and Privacy Policy to continue.', 'error');
    return;
  }

  if (captchaMissing('register')) {
    setStatus(registerStatus, 'Please complete the "I\'m not a robot" check first.', 'error');
    return;
  }

  registerSubmitBtn.disabled = true;
  setStatus(registerStatus, 'Creating your account…', '');
  try {
    const result = await createAccount(email, password, displayName, selectedRegisterRole, captchaToken('register'));
    if (result.error) {
      setStatus(registerStatus, result.error, 'error');
      return;
    }
    if (result.needsConfirmation) {
      // Email confirmation is on - no session yet. Show the dedicated
      // "confirm your email" screen (clearer than a one-line message on the
      // login form) rather than bouncing to login.
      pendingConfirmEmail = result.email;
      checkEmailAddress.textContent = result.email;
      checkEmailStatus.textContent = '';
      markAuthTab('login');
      // Sign-up just sent the confirmation email - start the resend cooldown
      // so the button isn't immediately mashable.
      startResendCooldown();
      showAuthForm('check-email');
      registerStatus.textContent = '';
      return;
    }
    loggedIn();
  } catch (err) {
    setStatus(registerStatus, 'Could not reach the server. Check your connection and try again.', 'error');
  } finally {
    // Restore to the checkbox-gated state, not unconditionally enabled.
    syncRegisterSubmitEnabled();
    resetCaptcha('register');
  }
});
