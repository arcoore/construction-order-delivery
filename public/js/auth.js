// Real Supabase Auth accounts (Phase 8B) — replaces the old plaintext
// localStorage account system entirely. "Skip for now" / guest mode has
// been removed: an account is now required to use SiteStock at all (see
// PROGRESS.md's Phase 8B section for why — anonymous Supabase auth is a
// deliberately separate, not-yet-taken step).
//
// This module owns Supabase session state ONLY — no profile data lives
// here. display_name/default_role are read straight off the session's own
// user_metadata (set once at signUp, never queried from another table),
// since they're the current user's own account facts, never looked up for
// anyone else. Looking up *other* users' display names is identity.js's
// job (profiles table), not this module's.
import { supabase } from './supabaseClient.js';

let currentSession = null;

const listeners = new Set();
function notify() {
  listeners.forEach(fn => fn());
}

export function subscribeAuth(fn) {
  listeners.add(fn);
  fn();
  return () => listeners.delete(fn);
}

// main.js's bootstrap awaits this before the first route happens — nothing
// ever renders a role view off an unknown/uninitialized auth state.
export const authReady = supabase.auth.getSession().then(({ data }) => {
  currentSession = data.session;
  notify();
});

// Fires on every sign-in/sign-out/token-refresh, including the initial
// resolution above and a cross-tab session change — this is the one place
// currentSession is ever written after bootstrap.
supabase.auth.onAuthStateChange((_event, session) => {
  currentSession = session;
  notify();
});

const VALID_ROLES = ['worker', 'driver', 'buyer', 'owner'];

function accountFromSession(session) {
  if (!session || !session.user) return null;
  const u = session.user;
  return {
    id: u.id,
    email: u.email,
    displayName: u.user_metadata?.display_name || '',
    defaultRole: u.user_metadata?.default_role || null,
    createdAt: u.created_at ? new Date(u.created_at).getTime() : Date.now(),
  };
}

export function getLoggedInAccount() {
  return accountFromSession(currentSession);
}

export function isAuthenticated() {
  return !!getLoggedInAccount();
}

function friendlyAuthError(error) {
  const msg = (error && error.message) || 'Something went wrong.';
  if (/already registered|already exists/i.test(msg)) return 'That email is already registered.';
  if (/invalid login credentials/i.test(msg)) return 'Incorrect email or password.';
  if (/password.*(least|short)/i.test(msg)) return msg;
  return msg;
}

export async function createAccount(email, password, displayName, defaultRole) {
  email = (email || '').trim();
  displayName = (displayName || '').trim();
  if (!email || !password || !displayName) {
    return { error: 'Please fill in every field.' };
  }
  if (!VALID_ROLES.includes(defaultRole)) {
    return { error: 'Please choose your role.' };
  }
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { display_name: displayName, default_role: defaultRole } },
  });
  if (error) return { error: friendlyAuthError(error) };
  // Local dev has email confirmations disabled, so signUp returns a real
  // session immediately — if a real cloud project later requires
  // confirmation, `data.session` comes back null here and this would need
  // a "check your email" state. Not built yet; not needed locally.
  if (!data.session) {
    return { error: 'Account created — check your email to confirm before logging in.' };
  }
  currentSession = data.session;
  notify();
  return { account: accountFromSession(data.session) };
}

export async function login(email, password) {
  email = (email || '').trim();
  if (!email || !password) return { error: 'Please fill in every field.' };
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { error: friendlyAuthError(error) };
  currentSession = data.session;
  notify();
  return { account: accountFromSession(data.session) };
}

export async function logout() {
  await supabase.auth.signOut();
  currentSession = null;
  notify();
}
