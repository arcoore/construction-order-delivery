// Pure Stripe helpers shared by the three billing Edge Functions - no network,
// no Deno globals beyond Web Crypto, so `deno test` can exercise all of it
// (see stripe_test.ts). Nothing in here holds a secret; callers pass keys in.
//
// SiteStock talks to Stripe with plain fetch + form-encoding rather than the
// Stripe SDK: three endpoints, no build step, and one less dependency to trust
// with a secret key.

const encoder = new TextEncoder();

// ---------------------------------------------------------------- signature
// Stripe signs every webhook: header `Stripe-Signature: t=<unix>,v1=<hex>[,v1=<hex>]`
// where v1 = HMAC-SHA256(secret, `${t}.${rawBody}`). Verification must use the
// RAW body text (re-serialising parsed JSON changes bytes), reject stale
// timestamps (replay), and compare in constant time - crypto.subtle.verify does
// that last part for us.
export type SignatureResult = { ok: true; timestamp: number } | { ok: false; reason: string };

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function signPayload(secret: string, timestamp: string | number, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${payload}`)));
  return [...mac].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function verifyStripeSignature(
  payload: string,
  header: string | null,
  secret: string,
  opts: { toleranceSeconds?: number; nowSeconds?: number } = {},
): Promise<SignatureResult> {
  if (!secret) return { ok: false, reason: 'no_secret' };
  if (!header) return { ok: false, reason: 'missing_header' };
  const tolerance = opts.toleranceSeconds ?? 300;
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);

  let timestamp = '';
  const candidates: string[] = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === 't') timestamp = v;
    else if (k === 'v1') candidates.push(v);
  }
  if (!/^\d{1,12}$/.test(timestamp) || candidates.length === 0) return { ok: false, reason: 'malformed_header' };
  const t = Number(timestamp);
  if (Math.abs(now - t) > tolerance) return { ok: false, reason: 'timestamp_outside_tolerance' };

  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const message = encoder.encode(`${timestamp}.${payload}`);
  for (const candidate of candidates) {
    const sig = hexToBytes(candidate);
    if (!sig) continue;
    if (await crypto.subtle.verify('HMAC', key, sig, message)) return { ok: true, timestamp: t };
  }
  return { ok: false, reason: 'no_matching_signature' };
}

// ------------------------------------------------------------ event mapping
export interface BillingEventInput {
  eventId: string;
  eventType: string;
  created: number;
  communityId: string | null;
  customerId: string | null;
  subscriptionId: string | null;
  status: string | null;
  currentPeriodEnd: string | null; // ISO-8601, or null
  cancelAtPeriodEnd: boolean | null;
}

const KNOWN_STATUSES = new Set([
  'incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused',
]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidOrNull(v: unknown): string | null {
  return typeof v === 'string' && UUID_RE.test(v) ? v.toLowerCase() : null;
}
// Stripe returns a related object either as its id or, when expanded, as an object.
function idOf(v: unknown): string | null {
  if (typeof v === 'string' && v) return v;
  if (v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string') return (v as { id: string }).id;
  return null;
}
function isoFromEpoch(v: unknown): string | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? new Date(v * 1000).toISOString() : null;
}

// Returns null for any event we don't act on (Stripe sends dozens of types; the
// webhook should still answer 200 to those so it isn't retried).
//
// Deliberately conservative: an unrecognised subscription status becomes
// `status: null` ("link the ids, change nothing") rather than an error. The
// database function refuses unknown statuses, and a refusal makes Stripe retry
// the same event for days - so a future Stripe status must degrade to a no-op,
// never to a retry storm.
export function mapStripeEvent(event: unknown): BillingEventInput | null {
  // deno-lint-ignore no-explicit-any
  const e = event as any;
  const obj = e?.data?.object;
  if (typeof e?.id !== 'string' || typeof e?.type !== 'string' || !obj || typeof e.created !== 'number') return null;

  if (e.type === 'checkout.session.completed') {
    if (obj.mode !== 'subscription') return null;
    const status = obj.payment_status === 'paid' ? 'active'
      : obj.payment_status === 'no_payment_required' ? 'trialing'
      : null;
    return {
      eventId: e.id,
      eventType: e.type,
      created: e.created,
      communityId: uuidOrNull(obj.client_reference_id) ?? uuidOrNull(obj.metadata?.community_id),
      customerId: idOf(obj.customer),
      subscriptionId: idOf(obj.subscription),
      status,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: null,
    };
  }

  if (
    e.type === 'customer.subscription.created' ||
    e.type === 'customer.subscription.updated' ||
    e.type === 'customer.subscription.deleted'
  ) {
    const raw = e.type === 'customer.subscription.deleted' ? 'canceled' : obj.status;
    // current_period_end moved from the subscription to its items in newer Stripe API versions.
    const periodEnd = obj.current_period_end ?? obj.items?.data?.[0]?.current_period_end;
    return {
      eventId: e.id,
      eventType: e.type,
      created: e.created,
      communityId: uuidOrNull(obj.metadata?.community_id),
      customerId: idOf(obj.customer),
      subscriptionId: idOf(obj.id),
      status: typeof raw === 'string' && KNOWN_STATUSES.has(raw) ? raw : null,
      currentPeriodEnd: isoFromEpoch(periodEnd),
      cancelAtPeriodEnd: typeof obj.cancel_at_period_end === 'boolean' ? obj.cancel_at_period_end : null,
    };
  }

  return null;
}

// ------------------------------------------------------------ API requests
// Stripe's REST API takes application/x-www-form-urlencoded with bracket
// notation for nesting: a[b]=c, a[0][b]=c.
export function formEncode(params: Record<string, unknown>, prefix = ''): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (item !== null && typeof item === 'object') parts.push(formEncode(item as Record<string, unknown>, `${name}[${i}]`));
        else parts.push(`${encodeURIComponent(`${name}[${i}]`)}=${encodeURIComponent(String(item))}`);
      });
    } else if (typeof value === 'object') {
      parts.push(formEncode(value as Record<string, unknown>, name));
    } else {
      parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
    }
  }
  return parts.filter(Boolean).join('&');
}

// Where Stripe sends the customer back to. The client proposes a URL; it is
// only honoured if its ORIGIN is one we already trust (the same allow-list as
// CORS), and the query/hash are replaced with our own marker - so this can
// never be turned into an open redirect off Stripe's page.
export function safeReturnUrl(raw: unknown, isAllowedOrigin: (origin: string) => boolean, marker: string): string | null {
  if (typeof raw !== 'string') return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (!isAllowedOrigin(u.origin)) return null;
  u.search = '';
  u.hash = '';
  u.searchParams.set('billing', marker);
  return u.toString();
}

export function buildCheckoutParams(a: {
  priceId: string;
  communityId: string;
  successUrl: string;
  cancelUrl: string;
  customerId?: string | null;
  email?: string | null;
}): Record<string, unknown> {
  return {
    mode: 'subscription',
    line_items: [{ price: a.priceId, quantity: 1 }],
    // The company id travels on BOTH the session and the subscription, so
    // checkout.session.completed and every later customer.subscription.* event
    // can be matched to a company without a lookup.
    client_reference_id: a.communityId,
    metadata: { community_id: a.communityId },
    subscription_data: { metadata: { community_id: a.communityId } },
    success_url: a.successUrl,
    cancel_url: a.cancelUrl,
    allow_promotion_codes: 'true',
    ...(a.customerId ? { customer: a.customerId } : a.email ? { customer_email: a.email } : {}),
  };
}
