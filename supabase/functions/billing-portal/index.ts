// Opens Stripe's hosted billing portal (update card, see invoices, cancel) for a
// company that already has a Stripe customer. Same trust model as
// billing-checkout: caller identity from their JWT, ownership from the SQL
// function billing_checkout_context(), return URL origin-allow-listed. Dark
// (503) until STRIPE_SECRET_KEY exists.

import { corsHeadersFor, isAllowedOrigin, jsonResponse, stripePost } from '../_shared/http.ts';
import { authenticateCaller } from '../_shared/caller.ts';
import { formEncode, safeReturnUrl } from '../_shared/stripe.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async req => {
  const cors = corsHeadersFor(req);
  const json = (body: unknown, status: number) => jsonResponse(body, status, cors);

  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

  const secretKey = Deno.env.get('STRIPE_SECRET_KEY');
  if (!secretKey) return json({ error: 'Billing is not switched on yet.', code: 'billing_not_configured' }, 503);

  const caller = await authenticateCaller(req);
  if (!caller.ok) return json({ error: caller.error }, caller.status);

  const body = await req.json().catch(() => ({}));
  const communityId = typeof body?.communityId === 'string' ? body.communityId : '';
  if (!UUID_RE.test(communityId)) return json({ error: 'A valid company is required.' }, 400);

  const returnUrl = safeReturnUrl(body?.returnUrl, isAllowedOrigin, 'returned');
  if (!returnUrl) return json({ error: 'That return address is not allowed.' }, 400);

  const { data: ctx, error: ctxError } = await caller.client.rpc('billing_checkout_context', { p_community_id: communityId });
  if (ctxError) {
    if (ctxError.code === '42501') return json({ error: 'Only a company owner can manage billing.' }, 403);
    return json({ error: 'Could not check your company. Please try again.' }, 500);
  }
  if (!ctx?.customerId) {
    return json({ error: 'This company has no subscription to manage yet.', code: 'no_customer' }, 409);
  }

  const session = await stripePost(
    '/v1/billing_portal/sessions',
    formEncode({ customer: ctx.customerId, return_url: returnUrl }),
    secretKey,
  );
  const url = session.data?.url;
  if (!session.ok || typeof url !== 'string') {
    console.error('billing-portal: Stripe refused the session', session.status);
    return json({ error: 'Could not open the billing page. Please try again in a moment.' }, 502);
  }
  return json({ url }, 200);
});
