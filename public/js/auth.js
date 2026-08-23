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

// Roadmap Step 5 — password recovery. Supabase-js fires a real
// PASSWORD_RECOVERY auth event (distinct from SIGNED_IN) when it detects a
// recovery link's URL fragment on load (detectSessionInUrl: true, set in
// supabaseClient.js). A recovery link DOES establish a real, usable session
// — so isAuthenticated() would already be true the moment that happens,
// which would otherwise make main.js's ordinary bootstrap route straight
// into the community picker before the user ever gets to set a new
// password. inPasswordRecoveryContext() is the explicit gate main.js's
// routeFromTop() checks first, before anything else, to prevent exactly
// that (see main.js).
//
// The initial value below is a synchronous, best-effort check of the URL
// hash itself (the same `type=recovery` marker Supabase's own link uses) —
// needed because there's no strict ordering guarantee between authReady's
// getSession() resolving and onAuthStateChange's first PASSWORD_RECOVERY
// event actually firing; both are driven by the same underlying
// detectSessionInUrl processing, but relying on event-firing order alone
// would be a real, if narrow, race. This never parses or extracts the
// token itself — that's entirely supabase-js's job — it only reads a
// public, non-secret marker to decide whether to gate routing, and the
// authoritative PASSWORD_RECOVERY event (below) confirms/extends it.
let inPasswordRecovery = /type=recovery/.test(window.location.hash);
export function inPasswordRecoveryContext() {
  return inPasswordRecovery;
}

// main.js's bootstrap awaits this before the first route happens — nothing
// ever renders a role view off an unknown/uninitialized auth state.
export const authReady = supabase.auth.getSession().then(({ data }) => {
  currentSession = data.session;
  notify();
});

// Fires on every sign-in/sign-out/token-refresh/password-recovery,
// including the initial resolution above and a cross-tab session change —
// this is the one place currentSession is ever written after bootstrap.
supabase.auth.onAuthStateChange((event, session) => {
  currentSession = session;
  if (event === 'PASSWORD_RECOVERY') inPasswordRecovery = true;
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

// Roadmap Step 5 — password reset. Always returns the same generic success
// shape regardless of whether the email is actually registered — this is
// Supabase's own resetPasswordForEmail behavior already (it never reveals
// account existence), and the caller (authView.js) must not undermine that
// by branching UI copy on anything this returns beyond a real network
// failure. redirectTo is computed from window.location at call time (never
// hardcoded) so the same code works unmodified on localhost, GitHub Pages,
// or any future host — matching env.js's existing "no build-time env
// injection, read the actual runtime location" approach.
export async function requestPasswordReset(email) {
  email = (email || '').trim();
  if (!email) return { error: 'Please enter your email.' };
  const redirectTo = window.location.origin + window.location.pathname;
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
  // A real send failure (bad request, rate limit, network) is shown as an
  // error; anything else — including "no such account" — must never be
  // distinguishable from success, so only a genuine `error` from the call
  // itself is ever surfaced here.
  if (error) return { error: friendlyAuthError(error) };
  return { ok: true };
}

// Only callable meaningfully while inPasswordRecoveryContext() is true (a
// real recovery session is active) — updateUser on that session both
// changes the password and leaves the user authenticated, no separate
// re-login step needed. Clears the recovery gate on success so main.js's
// routeFromTop() resumes normal routing immediately afterward.
export async function completePasswordReset(newPassword) {
  if (!newPassword) return { error: 'Please enter a new password.' };
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) return { error: friendlyAuthError(error) };
  inPasswordRecovery = false;
  notify();
  return { ok: true };
}
