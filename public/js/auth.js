// Local, browser-only accounts. There is no backend — this is stored in
// localStorage on this device only, so it's a stand-in for real
// authentication, not a secure system. Don't reuse a real password here.
const ACCOUNTS_KEY = 'sitestock_accounts_v1';
const SESSION_KEY = 'sitestock_logged_in_username';
const SKIPPED_KEY = 'sitestock_auth_skipped';

function readAccounts() {
  try {
    const raw = localStorage.getItem(ACCOUNTS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function writeAccounts(list) {
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(list));
  notify();
}

const listeners = new Set();
function notify() {
  listeners.forEach(fn => fn());
}

export function subscribeAuth(fn) {
  listeners.add(fn);
  fn();
  return () => listeners.delete(fn);
}

window.addEventListener('storage', e => {
  if (e.key === ACCOUNTS_KEY || e.key === SESSION_KEY || e.key === SKIPPED_KEY) notify();
});

function newId() {
  return crypto.randomUUID ? crypto.randomUUID() : `acct-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function findAccount(username) {
  const clean = (username || '').trim().toLowerCase();
  if (!clean) return null;
  return readAccounts().find(a => a.username.toLowerCase() === clean) || null;
}

const VALID_ROLES = ['worker', 'driver', 'owner'];

export function createAccount(username, password, displayName, defaultRole) {
  username = (username || '').trim();
  displayName = (displayName || '').trim();
  if (!username || !password || !displayName) {
    return { error: 'Please fill in every field.' };
  }
  if (!VALID_ROLES.includes(defaultRole)) {
    return { error: 'Please choose whether you\'re a worker, driver, or owner.' };
  }
  if (findAccount(username)) {
    return { error: 'That username is already taken.' };
  }
  const account = { id: newId(), username, password, displayName, defaultRole, createdAt: Date.now() };
  const accounts = readAccounts();
  accounts.push(account);
  writeAccounts(accounts);
  setSession(username);
  return { account };
}

export function login(username, password) {
  const account = findAccount(username);
  if (!account) {
    return { error: 'No account found with that username.' };
  }
  if (account.password !== password) {
    return { error: 'Incorrect password.' };
  }
  setSession(account.username);
  return { account };
}

function setSession(username) {
  localStorage.setItem(SESSION_KEY, username);
  localStorage.removeItem(SKIPPED_KEY);
  notify();
}

export function skipLogin() {
  localStorage.setItem(SKIPPED_KEY, '1');
  notify();
}

export function isSkipped() {
  return localStorage.getItem(SKIPPED_KEY) === '1';
}

export function logout() {
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(SKIPPED_KEY);
  notify();
}

export function getLoggedInAccount() {
  const username = localStorage.getItem(SESSION_KEY);
  return username ? findAccount(username) : null;
}

export function isAuthenticated() {
  return !!getLoggedInAccount() || isSkipped();
}
