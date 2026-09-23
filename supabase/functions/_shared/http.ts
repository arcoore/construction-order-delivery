// CORS + JSON helpers for the billing Edge Functions. Same explicit origin
// allow-list as delete-account (2026-09-22 security audit): both live hosts plus
// localhost/127.0.0.1 on any port - never a wildcard. When a custom domain
// exists, add it here AND in delete-account (see .tools/DOMAIN_CUTOVER.md).

const ALLOWED_ORIGINS = new Set([
  'https://arcoore.github.io',
  'https://construction-order-delivery.pages.dev',
]);

export function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  try {
    const { hostname } = new URL(origin);
    return hostname === 'localhost' || hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

export function corsHeadersFor(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin');
  const headers: Record<string, string> = {
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
  if (isAllowedOrigin(origin)) headers['Access-Control-Allow-Origin'] = origin as string;
  return headers;
}

export function jsonResponse(body: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...extra, 'Content-Type': 'application/json' },
  });
}

// The Stripe REST base. Overridable ONLY against the local stack (an http://
// SUPABASE_URL), so a mock Stripe can stand in during tests and a production
// project can never be pointed at anything but api.stripe.com.
export function stripeApiBase(): string {
  const override = Deno.env.get('STRIPE_API_BASE');
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  if (override && supabaseUrl.startsWith('http://')) return override.replace(/\/$/, '');
  return 'https://api.stripe.com';
}

export async function stripePost(
  path: string,
  body: string,
  secretKey: string,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const res = await fetch(`${stripeApiBase()}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}
