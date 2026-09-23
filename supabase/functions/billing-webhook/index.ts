// Stripe -> SiteStock webhook. The ONLY thing in the system that can turn a
// payment into `communities.premium`.
//
// Deployed with verify_jwt = false (supabase/config.toml): Stripe doesn't send a
// Supabase JWT. Authentication is Stripe's HMAC signature instead, checked over
// the RAW request body before anything is parsed or acted on. DARK by default -
// with STRIPE_WEBHOOK_SECRET unset it answers 503 and touches nothing, so a
// forged request can never do anything before real keys exist either.
//
// Response codes are chosen for Stripe's retry behaviour:
//   400  bad/missing signature  (don't retry a forgery)
//   200  handled, duplicate, stale, unmatched, or an event type we don't use
//        (retrying any of those changes nothing)
//   500  the database call failed  (retry - it may be transient)
//   503  billing not configured

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { jsonResponse } from '../_shared/http.ts';
import { mapStripeEvent, verifyStripeSignature } from '../_shared/stripe.ts';

Deno.serve(async req => {
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed.' }, 405);

  const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET');
  if (!webhookSecret) return jsonResponse({ error: 'Billing is not switched on yet.', code: 'billing_not_configured' }, 503);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) return jsonResponse({ error: 'Server misconfiguration.' }, 500);

  // RAW text - re-serialised JSON would not match the signed bytes.
  const rawBody = await req.text();
  const verdict = await verifyStripeSignature(rawBody, req.headers.get('stripe-signature'), webhookSecret);
  if (!verdict.ok) {
    console.error('billing-webhook: rejected', verdict.reason);
    return jsonResponse({ error: 'Invalid signature.' }, 400);
  }

  let event: unknown;
  try { event = JSON.parse(rawBody); } catch { return jsonResponse({ error: 'Invalid payload.' }, 400); }

  const input = mapStripeEvent(event);
  if (!input) return jsonResponse({ received: true, handled: false }, 200);

  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
  const { data, error } = await admin.rpc('apply_billing_event', {
    p_event_id: input.eventId,
    p_event_type: input.eventType,
    p_event_created: input.created,
    p_community_id: input.communityId,
    p_customer_id: input.customerId,
    p_subscription_id: input.subscriptionId,
    p_status: input.status,
    p_current_period_end: input.currentPeriodEnd,
    p_cancel_at_period_end: input.cancelAtPeriodEnd,
  });
  if (error) {
    console.error('billing-webhook: apply_billing_event failed', error.code, error.message);
    return jsonResponse({ error: 'Could not record the event.' }, 500);
  }
  return jsonResponse({ received: true, handled: true, outcome: data }, 200);
});
