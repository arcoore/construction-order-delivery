// Phase 8B: real Supabase accounts, email + password. "Skip for now" has
// been removed entirely — see auth.js's header for why. Every submit is now
// a real network call, so both forms disable their submit button for the
// duration (prevents a double-submit firing two signUp/signIn calls before
// the first one resolves) and show a simple loading/error/success status,
// same .form-status element the rest of the app already uses.
import { createAccount, login } from './auth.js';

const authTabs = document.getElementById('auth-tabs');
const loginForm = document.getElementById('login-form');
const registerForm = document.getElementById('register-form');
const loginStatus = document.getElementById('login-status');
const registerStatus = document.getElementById('register-status');
const loginSubmitBtn = document.getElementById('login-submit-btn');
const registerSubmitBtn = document.getElementById('register-submit-btn');
const registerRoleGroup = document.getElementById('register-role-group');

let selectedRegisterRole = null;

registerRoleGroup.addEventListener('click', e => {
  const btn = e.target.closest('.role-toggle-btn');
  if (!btn) return;
  selectedRegisterRole = btn.dataset.role;
  registerRoleGroup.querySelectorAll('.role-toggle-btn').forEach(b => b.classList.toggle('active', b === btn));
});

authTabs.addEventListener('click', e => {
  const btn = e.target.closest('.tab-btn');
  if (!btn) return;
  const tab = btn.dataset.authTab;
  authTabs.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
  loginForm.hidden = tab !== 'login';
  registerForm.hidden = tab !== 'register';
  loginStatus.textContent = '';
  registerStatus.textContent = '';
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
    loggedIn();
  } catch (err) {
    setStatus(loginStatus, 'Could not reach the server. Check your connection and try again.', 'error');
  } finally {
    loginSubmitBtn.disabled = false;
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

  registerSubmitBtn.disabled = true;
  setStatus(registerStatus, 'Creating your account…', '');
  try {
    const result = await createAccount(email, password, displayName, selectedRegisterRole);
    if (result.error) {
      setStatus(registerStatus, result.error, 'error');
      return;
    }
    loggedIn();
  } catch (err) {
    setStatus(registerStatus, 'Could not reach the server. Check your connection and try again.', 'error');
  } finally {
    registerSubmitBtn.disabled = false;
  }
});
