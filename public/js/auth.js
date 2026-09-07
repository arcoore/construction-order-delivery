// Real Supabase Auth accounts (Phase 8B) - replaces the old plaintext
// localStorage account system entirely. "Skip for now" / guest mode has
// been removed: an account is now required to use SiteStock at all (see
// PROGRESS.md's Phase 8B section for why - anonymous Supabase auth is a
// deliberately separate, not-yet-taken step).
//
// This module owns Supabase session state ONLY - no profile data lives
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

// Roadmap Step 5 - password recovery. Supabase-js fires a real
// PASSWORD_RECOVERY auth event (distinct from SIGNED_IN) when it detects a
// recovery link's URL fragment on load (detectSessionInUrl: true, set in
// supabaseClient.js). A recovery link DOES establish a real, usable session
// - so isAuthenticated() would already be true the moment that happens,
// which would otherwise make main.js's ordinary bootstrap route straight
// into the community picker before the user ever gets to set a new
// password. inPasswordRecoveryContext() is the explicit gate main.js's
// routeFromTop() checks first, before anything else, to prevent exactly
// that (see main.js).
//
// The initial value below is a synchronous, best-effort check of the URL
// hash itself (the same `type=recovery` marker Supabase's own link uses) - 
// needed because there's no strict ordering guarantee between authReady's
// getSession() resolving and onAuthStateChange's first PASSWORD_RECOVERY
// event actually firing; both are driven by the same underlying
// detectSessionInUrl processing, but relying on event-firing order alone
// would be a real, if narrow, race. This never parses or extracts the
// token itself - that's entirely supabase-js's job - it only reads a
// public, non-secret marker to decide whether to gate routing, and the
// authoritative PASSWORD_RECOVERY event (below) confirms/extends it.
let inPasswordRecovery = /type=recovery/.test(window.location.hash);
export function inPasswordRecoveryContext() {
  return inPasswordRecovery;
}

// main.js's bootstrap awaits this before the first route happens - nothing
// ever renders a role view off an unknown/uninitialized auth state.
export const authReady = supabase.auth.getSession().then(async ({ data }) => {
  currentSession = data.session;
  // A refresh mid-2FA-challenge (session is aal1, a verified factor exists)
  // must re-gate - the JS flag doesn't survive a reload, the AAL does.
  if (currentSession && await mfaLoginRequired()) mfaChallengePending = true;
  notify();
});

// Fires on every sign-in/sign-out/token-refresh/password-recovery,
// including the initial resolution above and a cross-tab session change - 
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
  const code = error && error.code;
  if (code === 'email_not_confirmed' || /email not confirmed/i.test(msg)) {
    return 'Check your email and click the confirmation link before logging in.';
  }
  if (/already registered|already exists/i.test(msg)) return 'That email is already registered.';
  if (/invalid login credentials/i.test(msg)) return 'Incorrect email or password.';
  if (/invalid.*(totp|code)|mfa/i.test(msg)) return 'That code isn\'t right - check your authenticator app and try again.';
  if (/password.*(least|short)/i.test(msg)) return msg;
  if (/captcha/i.test(msg)) return 'Please complete the "I\'m not a robot" check and try again.';
  return msg;
}

export async function createAccount(email, password, displayName, defaultRole, captchaToken) {
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
    options: {
      data: { display_name: displayName, default_role: defaultRole },
      // Where the confirmation link lands after Supabase verifies the token.
      // Computed from window.location (never hardcoded) so the same build
      // works on localhost and on the deployed site - matches how
      // requestPasswordReset / requestEmailChange already do it. Every origin
      // this can produce is in config.toml's additional_redirect_urls.
      emailRedirectTo: window.location.origin + window.location.pathname,
      // Cloudflare Turnstile token, when the CAPTCHA is switched on
      // (window.SITESTOCK_TURNSTILE_KEY set + [auth.captcha] enabled in
      // config.toml). Undefined/omitted when it's off, which is the current
      // default - GoTrue only enforces it when the project has captcha on.
      ...(captchaToken ? { captchaToken } : {}),
    },
  });
  if (error) return { error: friendlyAuthError(error) };
  // Email confirmation is required (config.toml enable_confirmations = true):
  // signUp returns no session, and the user must click the link in their
  // inbox before they can log in - a normal, non-error outcome the caller
  // shows as an info state, not a red error (see authView.js). Locally the
  // link's email is captured in Mailpit (http://127.0.0.1:54324) unless a
  // real SMTP provider is set in supabase/.env.
  if (!data.session) {
    return { needsConfirmation: true, email };
  }
  currentSession = data.session;
  notify();
  return { account: accountFromSession(data.session) };
}

// Re-send the signup confirmation email - the "Resend" button on the
// check-your-email screen. Supabase rate-limits this; a 429 becomes a
// friendly "wait a moment" rather than a raw error.
export async function resendConfirmation(email, captchaToken) {
  email = (email || '').trim();
  if (!email) return { error: 'No email address to resend to.' };
  const { error } = await supabase.auth.resend({
    type: 'signup',
    email,
    options: {
      emailRedirectTo: window.location.origin + window.location.pathname,
      ...(captchaToken ? { captchaToken } : {}),
    },
  });
  if (error) {
    if (error.code === 'over_email_send_rate_limit' || /rate limit|too many/i.test(error.message || '')) {
      return { error: 'Please wait a minute before asking for another email.' };
    }
    return { error: friendlyAuthError(error) };
  }
  return { ok: true };
}

export async function login(email, password, captchaToken) {
  email = (email || '').trim();
  if (!email || !password) return { error: 'Please fill in every field.' };
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
    options: captchaToken ? { captchaToken } : undefined,
  });
  if (error) return { error: friendlyAuthError(error) };
  currentSession = data.session;

  // Two-factor: if this account has a verified TOTP factor, the password
  // only got us to aal1 - the app stays gated (mfaChallengePending) until
  // verifyMfaLogin() steps the session up to aal2. main.js's routeFromTop()
  // checks mfaChallengePending() before the authenticated check, exactly
  // like the password-recovery gate.
  if (await mfaLoginRequired()) {
    mfaChallengePending = true;
    notify();
    return { mfaRequired: true };
  }
  notify();
  return { account: accountFromSession(data.session) };
}

// --- Two-factor (TOTP) --------------------------------------------------
// Supabase-native MFA (supabase.auth.mfa.*). Opt-in per account from the
// Profile screen. Once a factor is verified, login requires the 6-digit
// code (the client gate here + an aal2 re-check on the sensitive write
// RPCs - migration 0040 - so a stolen password + a raw aal1 token still
// can't place/approve orders or touch the company).
let mfaChallengePending = false; // set true by login() when a 2nd factor is owed
export function isMfaChallengePending() { return mfaChallengePending; }
export function clearMfaChallenge() { mfaChallengePending = false; notify(); }

async function currentAal() {
  try {
    const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    return data || { currentLevel: null, nextLevel: null };
  } catch {
    return { currentLevel: null, nextLevel: null };
  }
}

// True when the session is authenticated but hasn't cleared the second
// factor this login (aal1 now, aal2 expected).
export async function mfaLoginRequired() {
  if (!currentSession) return false;
  const { currentLevel, nextLevel } = await currentAal();
  return nextLevel === 'aal2' && currentLevel !== 'aal2';
}

async function verifiedTotpFactorId() {
  try {
    const { data } = await supabase.auth.mfa.listFactors();
    const totp = (data && data.totp) || [];
    const verified = totp.find(f => f.status === 'verified') || totp[0];
    return verified ? verified.id : null;
  } catch {
    return null;
  }
}

// Whether the CURRENT user has 2FA switched on - for the Profile toggle.
export async function getMfaEnabled() {
  return !!(await verifiedTotpFactorId());
}

// Step 1 of turning 2FA on: enroll a TOTP factor and hand back the QR /
// secret for the user to add to their authenticator app.
export async function startMfaEnrollment() {
  // Clear any stale unverified factor first so re-enrolling doesn't pile up.
  try {
    const { data } = await supabase.auth.mfa.listFactors();
    for (const f of ((data && data.totp) || [])) {
      if (f.status !== 'verified') await supabase.auth.mfa.unenroll({ factorId: f.id });
    }
  } catch { /* best effort */ }
  const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'SiteStock' });
  if (error) return { error: friendlyAuthError(error) };
  return { factorId: data.id, qrSvg: data.totp.qr_code, secret: data.totp.secret };
}

// Step 2: the user types the 6-digit code from their app to confirm the
// factor. On success 2FA is on and this session is now aal2.
export async function confirmMfaEnrollment(factorId, code) {
  code = (code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) return { error: 'Enter the 6-digit code from your authenticator app.' };
  const ch = await supabase.auth.mfa.challenge({ factorId });
  if (ch.error) return { error: friendlyAuthError(ch.error) };
  const { error } = await supabase.auth.mfa.verify({ factorId, challengeId: ch.data.id, code });
  if (error) return { error: friendlyAuthError(error) };
  mfaChallengePending = false;
  notify();
  return { ok: true };
}

// Login-time challenge: the user has 2FA and just entered their password.
export async function verifyMfaLogin(code) {
  code = (code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) return { error: 'Enter the 6-digit code from your authenticator app.' };
  const factorId = await verifiedTotpFactorId();
  if (!factorId) { mfaChallengePending = false; notify(); return { ok: true }; }
  const ch = await supabase.auth.mfa.challenge({ factorId });
  if (ch.error) return { error: friendlyAuthError(ch.error) };
  const { error } = await supabase.auth.mfa.verify({ factorId, challengeId: ch.data.id, code });
  if (error) return { error: friendlyAuthError(error) };
  mfaChallengePending = false;
  notify();
  return { ok: true };
}

// Turn 2FA off (unenroll every TOTP factor). Requires the current session
// to already be aal2 - Supabase refuses unenroll otherwise, which is the
// desired behaviour (you can't drop 2FA without passing it).
export async function disableMfa() {
  try {
    const { data } = await supabase.auth.mfa.listFactors();
    for (const f of ((data && data.totp) || [])) {
      const { error } = await supabase.auth.mfa.unenroll({ factorId: f.id });
      if (error) return { error: friendlyAuthError(error) };
    }
  } catch (e) {
    return { error: 'Could not turn 2FA off - try again.' };
  }
  notify();
  return { ok: true };
}

export async function logout() {
  await supabase.auth.signOut();
  currentSession = null;
  mfaChallengePending = false;
  notify();
}

// Product-audit gap fix: self-service account deletion. Deleting an Auth
// user requires the service_role key, which must never reach the browser
// (see CLAUDE.md's guardrails) - so this calls a server-side Edge Function
// (supabase/functions/delete-account) instead of touching auth.admin
// directly. That function forwards this call's own session as the
// Authorization header automatically (supabase-js's functions.invoke
// default), verifies the caller server-side, then attempts the deletion
// with its own admin client.
//
// profiles.id has no ON DELETE CASCADE from orders/sites/communities.owner_id
// on purpose - deleting an account must never silently delete a company's
// real business records. That means the deletion genuinely only succeeds
// for an account with no owned history at all (a fresh signup, essentially);
// any real account still creating/purchasing/driving/owning something is
// refused with a clear, honest error rather than partially succeeding or
// silently corrupting historical records. There is deliberately no
// automatic anonymization path - that needs a real policy decision, not a
// default baked in here.
export async function deleteAccount() {
  const { data, error } = await supabase.functions.invoke('delete-account');
  if (error) {
    // supabase-js surfaces a non-2xx function response as `error`, with the
    // function's own JSON body (containing our friendly `error` message)
    // available on error.context - fall back to a generic message if that
    // shape isn't present (e.g. a genuine network failure reaching the
    // function at all).
    const body = await error.context?.json?.().catch(() => null);
    return { ok: false, error: body?.error || error.message || 'Could not delete your account.' };
  }
  if (data?.error) return { ok: false, error: data.error };
  await logout();
  return { ok: true };
}

// Roadmap Step 5 - password reset. Always returns the same generic success
// shape regardless of whether the email is actually registered - this is
// Supabase's own resetPasswordForEmail behavior already (it never reveals
// account existence), and the caller (authView.js) must not undermine that
// by branching UI copy on anything this returns beyond a real network
// failure. redirectTo is computed from window.location at call time (never
// hardcoded) so the same code works unmodified on localhost, GitHub Pages,
// or any future host - matching env.js's existing "no build-time env
// injection, read the actual runtime location" approach.
export async function requestPasswordReset(email, captchaToken) {
  email = (email || '').trim();
  if (!email) return { error: 'Please enter your email.' };
  const redirectTo = window.location.origin + window.location.pathname;
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo,
    ...(captchaToken ? { captchaToken } : {}),
  });
  // A real send failure (bad request, rate limit, network) is shown as an
  // error; anything else - including "no such account" - must never be
  // distinguishable from success, so only a genuine `error` from the call
  // itself is ever surfaced here.
  if (error) return { error: friendlyAuthError(error) };
  return { ok: true };
}

// Only callable meaningfully while inPasswordRecoveryContext() is true (a
// real recovery session is active) - updateUser on that session both
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

// Self-service display-name change (product-audit gap fix). display_name
// lives in two places that must stay in sync: the session's own
// user_metadata (what getCurrentDisplayName reads for the current user) and
// the profiles row (what everyone else's identity.js resolveDisplayName
// reads). updateUser writes the first (and returns the updated user, set on
// currentSession directly here the same way login()/createAccount() do, so
// the change is visible on the very next render without waiting for the
// USER_UPDATED event); the profiles UPDATE - allowed by the
// profiles_update_own RLS policy (0009) - writes the second. auth.uid(),
// the only thing any permission check depends on, never changes.
export async function updateDisplayName(newName) {
  newName = (newName || '').trim();
  if (!newName) return { error: 'Please enter a display name.' };
  if (newName.length > 60) return { error: 'That name is too long (60 characters max).' };
  const { data, error } = await supabase.auth.updateUser({ data: { display_name: newName } });
  if (error) return { error: friendlyAuthError(error) };
  if (data?.user && currentSession) currentSession = { ...currentSession, user: data.user };
  const uid = currentSession?.user?.id;
  if (uid) {
    const { error: profileError } = await supabase.from('profiles').update({ display_name: newName }).eq('id', uid);
    if (profileError) return { error: profileError.message };
  }
  notify();
  return { ok: true };
}

// Self-service email change (product-audit gap fix). Supabase Auth's own
// secure-email-change flow: updateUser({ email }) sends a confirmation link
// to the NEW address (and, depending on the project's Auth settings, also
// to the old one) - the change only takes effect once that link is
// followed. detectSessionInUrl is already true (set for password recovery),
// so the confirmation link is picked up automatically when the user returns.
// This function just kicks it off; it never changes the email directly.
// display_name / user_metadata are untouched, and auth.uid() - the only
// identity anything actually depends on - never changes.
export async function requestEmailChange(newEmail) {
  newEmail = (newEmail || '').trim();
  if (!newEmail) return { error: 'Please enter your new email address.' };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(newEmail)) return { error: 'That doesn\'t look like a valid email address.' };
  const redirectTo = window.location.origin + window.location.pathname;
  const { error } = await supabase.auth.updateUser({ email: newEmail }, { emailRedirectTo: redirectTo });
  if (error) return { error: friendlyAuthError(error) };
  return { ok: true };
}
