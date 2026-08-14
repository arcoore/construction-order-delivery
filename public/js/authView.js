import { createAccount, login, skipLogin } from './auth.js';

const authTabs = document.getElementById('auth-tabs');
const loginForm = document.getElementById('login-form');
const registerForm = document.getElementById('register-form');
const loginStatus = document.getElementById('login-status');
const registerStatus = document.getElementById('register-status');
const skipBtn = document.getElementById('skip-login-btn');
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

loginForm.addEventListener('submit', e => {
  e.preventDefault();
  const username = document.getElementById('login-username-input').value;
  const password = document.getElementById('login-password-input').value;
  const result = login(username, password);
  if (result.error) {
    loginStatus.textContent = result.error;
    loginStatus.className = 'form-status error';
    return;
  }
  loggedIn();
});

registerForm.addEventListener('submit', e => {
  e.preventDefault();
  const username = document.getElementById('register-username-input').value;
  const password = document.getElementById('register-password-input').value;
  const confirm = document.getElementById('register-confirm-input').value;
  const displayName = document.getElementById('register-displayname-input').value;

  if (password !== confirm) {
    registerStatus.textContent = "Passwords don't match.";
    registerStatus.className = 'form-status error';
    return;
  }

  if (!selectedRegisterRole) {
    registerStatus.textContent = "Please choose whether you're a worker, driver, or owner.";
    registerStatus.className = 'form-status error';
    return;
  }

  const result = createAccount(username, password, displayName, selectedRegisterRole);
  if (result.error) {
    registerStatus.textContent = result.error;
    registerStatus.className = 'form-status error';
    return;
  }
  loggedIn();
});

skipBtn.addEventListener('click', () => {
  skipLogin();
  window.dispatchEvent(new CustomEvent('sitestock:logged-in', { detail: { skipped: true } }));
});
