// Premium billing - browser half (see supabase/migrations/0055_premium_billing.sql
// for the whole trust chain).
//
// DARK BY DEFAULT: everything here is inert unless window.SITESTOCK_BILLING.enabled
// is set in env.js. That flag moves together with the Stripe secrets on the
// Supabase project - enabled here without them, the Edge Functions answer 503
// and the user just sees a plain "not available yet" message.
//
// This module never decides who is Premium and never writes it. The only things
// it does are: ask an Edge Function for a Stripe-hosted page URL and go there,
// read the company's own plan status (a column-limited, owner-only read), and
// turn that into words. The server is the authority on every one of them.
import { supabase } from './supabaseClient.js';

export function billingEnabled() {
  return !!(window.SITESTOCK_BILLING && window.SITESTOCK_BILLING.enabled);
}

// --- the ?billing=... marker Stripe's return URLs carry --------------------
// billing-checkout/billing-portal build success_url/cancel_url/return_url as
// <this page>?billing=success|cancelled|returned. Read once at startup, strip
// it from the address bar (so a refresh doesn't replay the message), and hold
// it in memory until the Owner dashboard has shown it - same one-shot pattern
// as the ?join= invite link (community.js's consumeJoinIntentFromUrl), and for
// the same reason it uses the query string, never the # fragment (reserved for
// Supabase's password-recovery link).
let pendingReturn = null;

export function consumeBillingReturnFromUrl() {
  try {
    const url = new URL(window.location.href);
    const marker = url.searchParams.get('billing');
    if (!marker) return null;
    url.searchParams.delete('billing');
    window.history.replaceState({}, '', url.pathname + (url.search || '') + url.hash);
    if (marker === 'success' || marker === 'cancelled' || marker === 'returned') pendingReturn = marker;
  } catch { /* no URL API / history blocked - the message is a nicety, not required */ }
  return pendingReturn;
}

// One-shot: returns the marker once, then null.
export function takeBillingReturn() {
  const marker = pendingReturn;
  pendingReturn = null;
  return marker;
}

// --- talking to the Edge Functions -----------------------------------------
async function messageFromInvokeError(error) {
  try {
    const body = await error.context.json();
    if (body && body.code === 'billing_not_configured') return 'Online payment isn\'t available yet. Please try again later.';
    if (body && typeof body.error === 'string') return body.error;
  } catch { /* fall through */ }
  return 'Could not reach the payment page. Please check your connection and try again.';
}

// Stripe-hosted pages live on *.stripe.com. Refusing anything else means even a
// compromised function response could not send someone to an arbitrary site.
export function isStripeUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && (u.hostname === 'stripe.com' || u.hostname.endsWith('.stripe.com'));
  } catch {
    return false;
  }
}

async function goToStripe(functionName, communityId) {
  if (!billingEnabled()) return { ok: false, error: 'Online payment isn\'t available yet.' };
  const { data, error } = await supabase.functions.invoke(functionName, {
    body: { communityId, returnUrl: window.location.origin + window.location.pathname },
  });
  if (error) return { ok: false, error: await messageFromInvokeError(error) };
  if (!data || !isStripeUrl(data.url)) return { ok: false, error: 'The payment page returned something unexpected. Please try again.' };
  window.location.assign(data.url);
  return { ok: true };
}

export function startCheckout(communityId) { return goToStripe('billing-checkout', communityId); }
export function openBillingPortal(communityId) { return goToStripe('billing-portal', communityId); }

// --- plan state -------------------------------------------------------------
// Owner-only, column-limited (0055): status/period end/cancel flag, never the
// Stripe ids. A non-owner or a company that never started checkout gets null.
export async function getBillingStatus(communityId) {
  const { data, error } = await supabase
    .from('company_billing')
    .select('status, current_period_end, cancel_at_period_end')
    .eq('community_id', communityId)
    .maybeSingle();
  if (error || !data) return null;
  return {
    status: data.status,
    currentPeriodEnd: data.current_period_end ? Date.parse(data.current_period_end) : null,
    cancelAtPeriodEnd: !!data.cancel_at_period_end,
  };
}

function formatDate(ms) {
  // Pinned to UK time: a renewal at 00:30 BST must not read as the day before to a UK owner.
  return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' });
}

// Pure. `billing` is getBillingStatus()'s result (or null). Returns the words
// for the Company settings "Plan" row, a tone for styling, and which button (if
// any) belongs under it. `action` is 'upgrade' | 'manage' | null; the caller
// additionally hides it unless billingEnabled().
export function planSummary({ premium, billing, sitesUsed, siteLimit }) {
  if (premium) {
    if (billing && billing.status === 'past_due') {
      return { text: 'Premium - your last payment didn\'t go through. Update your card to keep unlimited sites.', tone: 'warn', action: 'manage' };
    }
    if (billing && billing.cancelAtPeriodEnd && billing.currentPeriodEnd) {
      return { text: `Premium - cancelled. It stays active until ${formatDate(billing.currentPeriodEnd)}, then the company returns to the Free plan.`, tone: 'info', action: 'manage' };
    }
    if (billing && billing.currentPeriodEnd) {
      return { text: `Premium - unlimited sites. Renews on ${formatDate(billing.currentPeriodEnd)}.`, tone: 'ok', action: 'manage' };
    }
    // Premium with no billing row = switched on by hand (the pre-billing arrangement).
    return { text: 'Premium - unlimited sites.', tone: 'ok', action: billing ? 'manage' : null };
  }
  const ended = billing && (billing.status === 'canceled' || billing.status === 'unpaid');
  return {
    text: `${ended ? 'Free plan - your Premium subscription has ended. ' : 'Free plan - '}${sitesUsed} of ${siteLimit} sites used. Premium (£10/month) removes the limit.`,
    tone: 'info',
    action: 'upgrade',
  };
}

// What the user is told when they come back from Stripe.
export function returnNotice(marker) {
  if (marker === 'success') return { text: 'Thanks - your payment went through. Your Premium plan switches on within a few seconds.', tone: 'ok' };
  if (marker === 'cancelled') return { text: 'Checkout was cancelled - nothing was charged.', tone: 'info' };
  return null;
}
