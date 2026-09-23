// Run: deno test supabase/functions/_shared/stripe_test.ts
// (CI/local: docker run --rm -v "$PWD":/w -w /w denoland/deno:2.1.4 deno test supabase/functions/_shared/)
import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  buildCheckoutParams,
  formEncode,
  mapStripeEvent,
  safeReturnUrl,
  signPayload,
  verifyStripeSignature,
} from './stripe.ts';

const SECRET = 'whsec_test_secret';
const PAYLOAD = '{"id":"evt_1","type":"customer.subscription.updated"}';
// Computed independently with Python's hmac/hashlib, NOT with signPayload, so
// this catches a mistake in the signing code instead of just agreeing with it.
const PYTHON_SIG = '0d61487f09b9af74bab9136d29b42415a42bf22e4ab9eb82886337697ef0fe84';
const T = 1700000000;

Deno.test('signPayload matches an independently computed HMAC', async () => {
  assertEquals(await signPayload(SECRET, T, PAYLOAD), PYTHON_SIG);
});

Deno.test('a correct signature verifies', async () => {
  const r = await verifyStripeSignature(PAYLOAD, `t=${T},v1=${PYTHON_SIG}`, SECRET, { nowSeconds: T + 10 });
  assertEquals(r, { ok: true, timestamp: T });
});

Deno.test('any of several v1 signatures may match (Stripe rotates secrets)', async () => {
  const header = `t=${T},v1=${'0'.repeat(64)},v1=${PYTHON_SIG}`;
  assert((await verifyStripeSignature(PAYLOAD, header, SECRET, { nowSeconds: T })).ok);
});

Deno.test('a tampered body is rejected', async () => {
  const r = await verifyStripeSignature(PAYLOAD.replace('updated', 'deleted'), `t=${T},v1=${PYTHON_SIG}`, SECRET, { nowSeconds: T });
  assertEquals(r.ok, false);
});

Deno.test('the wrong secret is rejected', async () => {
  const r = await verifyStripeSignature(PAYLOAD, `t=${T},v1=${PYTHON_SIG}`, 'whsec_other', { nowSeconds: T });
  assertEquals(r.ok, false);
});

Deno.test('a replayed (stale) timestamp is rejected even with a valid signature', async () => {
  const r = await verifyStripeSignature(PAYLOAD, `t=${T},v1=${PYTHON_SIG}`, SECRET, { nowSeconds: T + 301 });
  assertEquals(r, { ok: false, reason: 'timestamp_outside_tolerance' });
  // ...and a timestamp from the future is refused symmetrically
  const f = await verifyStripeSignature(PAYLOAD, `t=${T},v1=${PYTHON_SIG}`, SECRET, { nowSeconds: T - 301 });
  assertEquals(f.ok, false);
});

Deno.test('missing, empty and malformed headers are rejected', async () => {
  for (const h of [null, '', 'garbage', `t=${T}`, `v1=${PYTHON_SIG}`, `t=abc,v1=${PYTHON_SIG}`, `t=${T},v1=zz`]) {
    assertEquals((await verifyStripeSignature(PAYLOAD, h, SECRET, { nowSeconds: T })).ok, false, String(h));
  }
});

Deno.test('an empty secret never verifies anything', async () => {
  // (Web Crypto refuses a zero-length key, so a signature can't even be made with one -
  // verify must therefore fail closed before it ever reaches importKey.)
  assertEquals(await verifyStripeSignature(PAYLOAD, `t=${T},v1=${PYTHON_SIG}`, '', { nowSeconds: T }), { ok: false, reason: 'no_secret' });
});

// ------------------------------------------------------------- event mapping
const CO = '11111111-2222-4333-8444-555555555555';

Deno.test('checkout.session.completed (paid subscription) links ids and marks active', () => {
  const m = mapStripeEvent({
    id: 'evt_a', type: 'checkout.session.completed', created: 10,
    data: { object: { mode: 'subscription', payment_status: 'paid', client_reference_id: CO, customer: 'cus_1', subscription: 'sub_1' } },
  });
  assertEquals(m?.communityId, CO);
  assertEquals(m?.status, 'active');
  assertEquals(m?.customerId, 'cus_1');
  assertEquals(m?.subscriptionId, 'sub_1');
});

Deno.test('checkout.session.completed: unpaid -> link only; one-off payments ignored', () => {
  const unpaid = mapStripeEvent({
    id: 'evt_b', type: 'checkout.session.completed', created: 10,
    data: { object: { mode: 'subscription', payment_status: 'unpaid', client_reference_id: CO, customer: 'cus_1', subscription: 'sub_1' } },
  });
  assertEquals(unpaid?.status, null);
  const oneOff = mapStripeEvent({
    id: 'evt_c', type: 'checkout.session.completed', created: 10,
    data: { object: { mode: 'payment', payment_status: 'paid', client_reference_id: CO } },
  });
  assertEquals(oneOff, null);
});

Deno.test('a client_reference_id that is not a UUID is not trusted as a company id', () => {
  const m = mapStripeEvent({
    id: 'evt_d', type: 'checkout.session.completed', created: 10,
    data: { object: { mode: 'subscription', payment_status: 'paid', client_reference_id: "x'; drop table communities;--", customer: 'cus_1', subscription: 'sub_1' } },
  });
  assertEquals(m?.communityId, null);
});

Deno.test('subscription events: status, metadata company, and period end (both API shapes)', () => {
  const legacy = mapStripeEvent({
    id: 'evt_e', type: 'customer.subscription.updated', created: 20,
    data: { object: { id: 'sub_1', customer: 'cus_1', status: 'past_due', cancel_at_period_end: true, current_period_end: 1800000000, metadata: { community_id: CO } } },
  });
  assertEquals(legacy?.status, 'past_due');
  assertEquals(legacy?.cancelAtPeriodEnd, true);
  assertEquals(legacy?.currentPeriodEnd, new Date(1800000000 * 1000).toISOString());
  assertEquals(legacy?.communityId, CO);

  const modern = mapStripeEvent({
    id: 'evt_f', type: 'customer.subscription.created', created: 20,
    data: { object: { id: 'sub_1', customer: { id: 'cus_1' }, status: 'active', items: { data: [{ current_period_end: 1800000000 }] }, metadata: {} } },
  });
  assertEquals(modern?.currentPeriodEnd, new Date(1800000000 * 1000).toISOString());
  assertEquals(modern?.customerId, 'cus_1'); // expanded customer object
  assertEquals(modern?.communityId, null);   // resolved by subscription id in SQL instead
});

Deno.test('customer.subscription.deleted is always canceled whatever the payload says', () => {
  const m = mapStripeEvent({
    id: 'evt_g', type: 'customer.subscription.deleted', created: 30,
    data: { object: { id: 'sub_1', customer: 'cus_1', status: 'active', metadata: { community_id: CO } } },
  });
  assertEquals(m?.status, 'canceled');
});

Deno.test('an unknown future status degrades to link-only, never an error', () => {
  const m = mapStripeEvent({
    id: 'evt_h', type: 'customer.subscription.updated', created: 40,
    data: { object: { id: 'sub_1', customer: 'cus_1', status: 'quantum_superposition', metadata: { community_id: CO } } },
  });
  assertEquals(m?.status, null);
});

Deno.test('irrelevant event types and malformed events are ignored', () => {
  assertEquals(mapStripeEvent({ id: 'e', type: 'invoice.paid', created: 1, data: { object: {} } }), null);
  assertEquals(mapStripeEvent({ id: 'e', type: 'customer.subscription.updated', data: { object: {} } }), null);
  assertEquals(mapStripeEvent(null), null);
  assertEquals(mapStripeEvent('nope'), null);
});

// -------------------------------------------------------------- API requests
Deno.test('formEncode handles nesting and arrays in Stripe bracket notation', () => {
  assertEquals(
    formEncode({ mode: 'subscription', line_items: [{ price: 'price_1', quantity: 1 }], metadata: { community_id: CO } }),
    `mode=subscription&line_items%5B0%5D%5Bprice%5D=price_1&line_items%5B0%5D%5Bquantity%5D=1&metadata%5Bcommunity_id%5D=${CO}`,
  );
  assertEquals(formEncode({ a: undefined, b: null, c: 'x y&z' }), 'c=x%20y%26z');
});

Deno.test('checkout params carry the company on session AND subscription, and the fixed price', () => {
  const p = buildCheckoutParams({
    priceId: 'price_123', communityId: CO, successUrl: 'https://a/?billing=success', cancelUrl: 'https://a/?billing=cancelled', email: 'o@x.com',
  });
  const encoded = formEncode(p);
  assert(encoded.includes(`client_reference_id=${CO}`));
  assert(encoded.includes(`subscription_data%5Bmetadata%5D%5Bcommunity_id%5D=${CO}`));
  assert(encoded.includes('line_items%5B0%5D%5Bprice%5D=price_123'));
  assert(encoded.includes('customer_email=o%40x.com'));
  assert(!encoded.includes('customer='));
  // an existing Stripe customer is reused instead of an email
  const again = formEncode(buildCheckoutParams({ priceId: 'p', communityId: CO, successUrl: 's', cancelUrl: 'c', customerId: 'cus_9', email: 'o@x.com' }));
  assert(again.includes('customer=cus_9'));
  assert(!again.includes('customer_email'));
});

Deno.test('safeReturnUrl only honours trusted origins and replaces the query', () => {
  const ok = (o: string) => o === 'https://arcoore.github.io';
  assertEquals(
    safeReturnUrl('https://arcoore.github.io/construction-order-delivery/?x=1#frag', ok, 'success'),
    'https://arcoore.github.io/construction-order-delivery/?billing=success',
  );
  assertEquals(safeReturnUrl('https://evil.example/steal', ok, 'success'), null);
  assertEquals(safeReturnUrl('javascript:alert(1)', ok, 'success'), null);
  assertEquals(safeReturnUrl('not a url', ok, 'success'), null);
  assertEquals(safeReturnUrl(undefined, ok, 'success'), null);
  // a look-alike host is not the trusted origin
  assertEquals(safeReturnUrl('https://arcoore.github.io.evil.example/', ok, 'success'), null);
});
