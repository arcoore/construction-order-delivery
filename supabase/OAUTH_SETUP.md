# Social sign-in setup — Google & Microsoft

Everything on the SiteStock side is already wired:

- The buttons exist in `public/index.html` (`#oauth-block`).
- `public/js/env.js` already lists `['google', 'azure']` in `SITESTOCK_OAUTH_PROVIDERS`.
- `public/js/auth.js` handles the redirect; `authView.js` shows a button only
  when GoTrue also reports the provider enabled.
- `supabase/migrations/0043_*` widens the display-name fallback for the name
  fields OAuth providers return.

**What's left is the part only you can do:** register an OAuth app with Google
and with Microsoft (each is a free account + ~15–20 min), then paste two values
and flip one switch per provider. Claude can't create those accounts or apps.

Apple is deliberately **not** here — it needs the $99/yr Apple Developer
Program; do it when SiteStock is wrapped as a native app.

---

## The one URL every provider needs

Each provider asks for an **authorised redirect URI** (a.k.a. callback URL).
It is **Supabase's** URL, never the app's:

| Environment | Redirect URI |
|---|---|
| Hosted (`sitestock-dev`) | `https://jntbbrkiygbobknzivpe.supabase.co/auth/v1/callback` |
| Local dev | `http://127.0.0.1:54321/auth/v1/callback` |

Add **both** to each provider so sign-in works locally and on the deployed
site with the same OAuth app.

---

## Google  (free)

1. <https://console.cloud.google.com> → create a project (e.g. "SiteStock").
2. **APIs & Services → OAuth consent screen**
   - User type: **External**.
   - App name: `SiteStock`. Support email: `arcooreacc@gmail.com`.
   - App domain / homepage: `https://arcoore.github.io/construction-order-delivery/`
   - Privacy policy: `…/privacy.html`  ·  Terms: `…/terms.html`
   - Authorised domain: `arcoore.github.io` (and later your real domain).
   - Leave it in **Testing** (up to 100 users — fine for a beta) or click
     **Publish** when you're ready for anyone.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**
   - Application type: **Web application**.
   - **Authorised redirect URIs:** add both URLs from the table above.
   - Create → copy the **Client ID** and **Client secret**.
4. Put them in `supabase/.env`:
   ```
   GOOGLE_OAUTH_CLIENT_ID=<the client id>
   GOOGLE_OAUTH_SECRET=<the client secret>
   ```
5. In `supabase/config.toml`, set `[auth.external.google] enabled = true`.
6. Restart local:  `./.tools/supabase.exe stop && ./.tools/supabase.exe start`
   For hosted:  `./.tools/supabase.exe config push`  (part of a deploy).
7. Reload the app → "Continue with Google" appears. Click it, sign in with a
   Google account, confirm you land back logged in.

---

## Microsoft  (free — Supabase calls it "azure")

1. <https://portal.azure.com> → **Microsoft Entra ID → App registrations → New
   registration**.
   - Name: `SiteStock`.
   - Supported account types: **Accounts in any organizational directory and
     personal Microsoft accounts** (this is the "common" tenant — any
     Microsoft account can sign in).
   - Redirect URI: platform **Web**, value = the hosted callback URL from the
     table above. Add the local one under **Authentication → Add a platform /
     Add URI** after creating.
2. Copy **Application (client) ID** → `AZURE_OAUTH_CLIENT_ID`.
3. **Certificates & secrets → New client secret** → copy its **Value** (not
   the Secret ID) → `AZURE_OAUTH_SECRET`.
   ⚠️ It **expires** (max 24 months) — note the date and set a reminder to
   regenerate it.
4. `supabase/.env`:
   ```
   AZURE_OAUTH_CLIENT_ID=<application client id>
   AZURE_OAUTH_SECRET=<the secret VALUE>
   ```
5. `supabase/config.toml`: `[auth.external.azure] enabled = true`.
   Leave `# url = …` commented to accept any Microsoft account; set it to a
   single tenant's authority URL only if you want to restrict to one company.
6. Restart / `config push` as above, reload, test "Continue with Microsoft".

---

## Turning one off again

Set `enabled = false` in `config.toml` and restart / `config push`. The
button disappears (the GoTrue gate closes); email + password login is never
affected. You can leave the two `*_OAUTH_*` values in `.env` — they're only
read when `enabled = true`.

## Hosted-only note

After `config push`, also check the hosted project's **Authentication → URL
Configuration** has the deployed site in its redirect allow-list (it already
does for password reset — same list).
