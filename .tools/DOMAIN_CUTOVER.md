# Custom-domain cutover checklist

Written 2026-09-23 so the day a real domain exists is a checklist, not an
investigation. **No domain exists yet**, and buying one needs an adult's payment
card (see the `sitestock-launch-blockers` memory) — this is everything to do
*after* that, in order. Placeholder used below: `NEWHOST` (e.g. `sitestock.co.uk`).

The app currently answers on two hosts, both wired to the same backend
(`sitestock-london`): `arcoore.github.io/construction-order-delivery/` (GitHub
Pages, a **sub-path**) and `construction-order-delivery.pages.dev` (Cloudflare
Pages, **root**). A custom domain is served from the root, so nothing in the app
may assume the `/construction-order-delivery/` prefix — `manifest.webmanifest`
already uses relative `start_url`/`scope`/`id` (`"."`) for exactly this reason.

## 0. Order matters — do not break logins mid-move

Add `NEWHOST` to every *allow-list* (steps 1–4) **before** pointing DNS at it or
changing any hard-coded URL (steps 5–7). Removing the old hosts is the *last* step
and optional; leaving them allow-listed costs nothing.

## 1. Supabase Auth — redirect allow-list (`supabase/config.toml`)

- `[auth] site_url` → `https://NEWHOST/`
- `additional_redirect_urls` → add `https://NEWHOST/**` (keep the two existing).
- `supabase config push` (linked to the hosted project). Password-reset
  and email-confirmation links are built from `site_url`; if it is wrong they land on
  the wrong host, which is the failure mode to check first.

## 2. Cloudflare Turnstile — allowed hostnames

Dashboard → Turnstile → the "SiteStock" widget → Hostnames → add `NEWHOST`.
Symptom if forgotten: error `110200` "domain not allowed" and no login button
works (this exact bug happened on the `pages.dev` cutover).

## 3. OAuth providers

- **Google** (Cloud Console → Credentials → the OAuth client): add `https://NEWHOST`
  to *Authorised JavaScript origins*. The redirect URI stays the Supabase one
  (`https://rcdrgoxtawlemhzmpcry.supabase.co/auth/v1/callback`) — unchanged.
- **Microsoft** (Entra → App registration → Authentication): same, add the origin.
- Update the "App domain / homepage / Authorised domain" text in `supabase/OAUTH_SETUP.md`.

## 4. Edge Function CORS allow-list

`supabase/functions/delete-account/index.ts` (and `billing-checkout`,
`billing-portal` once they exist) each have an explicit `ALLOWED_ORIGINS` list —
add `https://NEWHOST`, then redeploy each function
(`supabase functions deploy <name> --project-ref rcdrgoxtawlemhzmpcry`).
Do **not** widen to `*` (see CLAUDE.md, 2026-09-22 security audit).

## 5. Frontend host mapping — `public/js/env.js`

`env.js` picks the backend by hostname and **refuses to start on an unknown host**
(deliberate fail-safe). Add `NEWHOST` to the `if (host === 'arcoore.github.io' || …)`
condition, and to the Turnstile comment. `www.NEWHOST` needs its own entry if used.

## 6. Hard-coded absolute URLs in the pages

All are `https://arcoore.github.io/construction-order-delivery/…`. One sed does it,
but note the **path prefix disappears** on a root domain:

| File(s) | What |
|---|---|
| `public/index.html`, `404.html`, `privacy.html`, `terms.html` (+ `eula`, `dmca`, `refunds`, `accessibility`) | `canonical`, `og:url`, `og:image`, `twitter:image` |
| `public/sitemap.xml` | seven `<loc>` entries |
| `public/robots.txt` | `Sitemap:` line |

Also check: `public/manifest.webmanifest` (relative — should need nothing) and
`public/sw.js` (scope is relative — should need nothing).

## 7. Security headers / CSP

Every page's CSP is `'self'`-based, so a new host needs no CSP change. `connect-src`
allows `https://*.supabase.co` / `wss://*.supabase.co` (any project subdomain) plus the
local `127.0.0.1:54321` dev API only — unchanged by a domain move. Outbound supplier
links and the Stripe Checkout redirect are plain navigations, which CSP does not restrict.

## 8. Hosting

- **Cloudflare Pages** (`construction-order-delivery.pages.dev`): Pages project →
  Custom domains → add `NEWHOST` (Cloudflare provisions TLS itself).
- If DNS is at another registrar: a `CNAME` (subdomain) or the registrar's ALIAS/
  ANAME (apex) to the `pages.dev` host. Prefer moving nameservers to Cloudflare.
- GitHub Pages can stay as a fallback mirror; it needs no change (sub-path host).

## 9. Third-party consoles that record the site URL

- **UptimeRobot** (2 monitors + status page): repoint the HTTP monitors to `NEWHOST`
  (keep one on the old host until DNS has settled).
- **Microsoft Clarity** project → Settings → Setup: the site URL.
- **Cloudflare Web Analytics** site: hostname.
- **Awin publisher account** (once it exists): the registered website URL must be the
  live one — an affiliate account tied to a dead hostname stops tracking.
- **Stripe** (once it exists): Settings → Business → public details URL; and the
  webhook endpoint is a Supabase URL, so it does *not* change.

## 10. Email

Auth emails go out via Brevo SMTP from `arcooreacc@gmail.com`. A real domain is the
moment to send from `noreply@NEWHOST` instead: add + verify the domain in Brevo
(SPF, DKIM, DMARC DNS records), then set `SMTP_ADMIN_EMAIL` (the sender address, read by
`[auth.email.smtp] admin_email` in `config.toml`) in the git-ignored `supabase/.env` and `config push`. Gmail-sender mail is the most likely thing to land
in spam at scale — do this before promoting the site.

## 11. Verify (after DNS settles)

1. Load `https://NEWHOST/` — no console errors, Turnstile widget renders.
2. Sign up a disposable account → confirmation email link lands on `NEWHOST`.
3. Password reset round-trip lands on `NEWHOST` and completes.
4. "Continue with Google" and "…Microsoft" complete and return to `NEWHOST`.
5. Install banner / PWA install works; `manifest` `start_url` resolves.
6. Delete-account from Profile completes (CORS allow-list check).
7. `curl -I` the old hosts still 200 (they remain as mirrors).
8. Update this file's header, `CLAUDE.md`'s top banner, and the UptimeRobot status
   page description with the new canonical host.
