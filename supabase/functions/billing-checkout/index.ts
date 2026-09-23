// Starts a Stripe Checkout Session for upgrading a company to Premium.
//
// DARK BY DEFAULT: with STRIPE_SECRET_KEY / STRIPE_PRICE_ID unset this answers
// 503 `billing_not_configured` and does nothing else. The browser also has its
// own switch (window.SITESTOCK_BILLING.enabled in public/js/env.js), so the
// "Upgrade" button only exists once both halves are on.
//
// What this function trusts, and what it doesn't:
//   * WHO is asking - resolved from the caller's own JWT (see _shared/caller.ts).
//   * WHETHER they may pay for THIS company - decided by the SQL function
//     billing_checkout_context(), which requires is_owner(company, auth.uid()).
//     The company id comes from the body but is only ever used AFTER that check.
//   * The price - taken from the STRIPE_PRICE_ID secret, never from the request,
//     so a caller can't ask for a cheaper or different price.
//   * Where Stripe returns the browser to - the client proposes, but the origin
//     must be on the allow-list and the query is replaced (safeReturnUrl).
// Nothing here changes `premium`: only Stripe's signed webhook does that.

import { corsHeadersFor, isAllowedOrigin, jsonResponse, stripePost } from '../_shared/http.ts';
import { authenticateCaller } from '../_shared/caller.ts';
import { buildCheckoutParams, formEncode, safeReturnUrl } from '../_shared/stripe.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async req => {
  const cors = corsHeadersFor(req);
  const json = (body: unknown, status: number) => jsonResponse(body, status, cors);

  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

  const secretKey = Deno.env.get('STRIPE_SECRET_KEY');
  const priceId = Deno.env.get('STRIPE_PRICE_ID');
  if (!secretKey || !priceId) {
    return json({ error: 'Billing is not switched on yet.', code: 'billing_not_configured' }, 503);
  }

  const caller = await authenticateCaller(req);
  if (!caller.ok) return json({ error: caller.error }, caller.status);

  const body = await req.json().catch(() => ({}));
  const communityId = typeof body?.communityId === 'string' ? body.communityId : '';
  if (!UUID_RE.test(communityId)) return json({ error: 'A valid company is required.' }, 400);

  const successUrl = safeReturnUrl(body?.returnUrl, isAllowedOrigin, 'success');
  const cancelUrl = safeReturnUrl(body?.returnUrl, isAllowedOrigin, 'cancelled');
  if (!successUrl || !cancelUrl) return json({ error: 'That return address is not allowed.' }, 400);

  const { data: ctx, error: ctxError } = await caller.client.rpc('billing_checkout_context', { p_community_id: communityId });
  if (ctxError) {
    if (ctxError.code === '42501') return json({ error: 'Only a company owner can manage billing.' }, 403);
    return json({ error: 'Could not check your company. Please try again.' }, 500);
  }
  if (ctx?.premium) {
    return json({ error: 'This company is already on Premium.', code: 'already_premium' }, 409);
  }

  const session = await stripePost(
    '/v1/checkout/sessions',
    formEncode(buildCheckoutParams({
      priceId,
      communityId,
      successUrl,
      cancelUrl,
      customerId: ctx?.customerId ?? null,
      email: caller.user.email ?? null,
    })),
    secretKey,
  );

  const url = session.data?.url;
  if (!session.ok || typeof url !== 'string') {
    // Never echo Stripe's error body to the browser - it can name account details.
    console.error('billing-checkout: Stripe refused the session', session.status);
    return json({ error: 'Could not start checkout. Please try again in a moment.' }, 502);
  }
  return json({ url }, 200);
});
