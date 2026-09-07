// Leaked-password check - a free, pre-launch stand-in for Supabase Pro's
// built-in "leaked password protection" (which needs the paid plan).
//
// Same mechanism the paid feature uses: Have I Been Pwned's Pwned Passwords
// range API (https://haveibeenpwned.com/API/v3#PwnedPasswords). It is free,
// needs no API key, and is k-anonymous - only the first 5 characters of the
// password's SHA-1 hash ever leave the browser, so the service can't tell
// which password (or even which account) was checked. `Add-Padding` makes
// every response a uniform size so the number of matches can't be inferred
// from traffic size either.
//
// Difference from the paid version: this runs in the browser, so it protects
// anyone using the actual sign-up / reset forms (i.e. real users choosing a
// weak password) but a script hitting the auth API directly could skip it.
// That's an acceptable gap for launch - the point of this check is to stop
// people picking "Password1", not to stop a determined attacker, and it can
// be swapped for the server-side version by enabling it on Supabase Pro
// later (see supabase/config.toml).
//
// Fails OPEN: any network / API error returns "not pwned" so a Cloudflare
// blip or an offline user is never locked out of signing up. A tiny local
// list still catches the very worst passwords with no network at all.

const WORST = new Set([
  'password', 'password1', 'password123', '12345678', '123456789', '1234567890',
  'qwertyuiop', 'qwerty123', '11111111', '00000000', 'iloveyou', 'admin123',
  'letmein', 'welcome1', 'abc12345', 'football', 'baseball', 'sunshine',
  'princess', 'trustno1', 'superman', 'passw0rd', 'p@ssw0rd', 'changeme',
  'starwars', 'whatever', 'zaq12wsx', 'dragon123', 'monkey123', 'master123',
]);

async function sha1Hex(str) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

// Returns { pwned: boolean, checked: boolean }. `checked` is false when the
// online check couldn't run (so the caller knows the result is best-effort).
export async function isPasswordPwned(password) {
  if (!password) return { pwned: false, checked: true };
  if (WORST.has(password.toLowerCase())) return { pwned: true, checked: true };

  try {
    const hash = await sha1Hex(password);
    const prefix = hash.slice(0, 5);
    const suffix = hash.slice(5);
    const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { 'Add-Padding': 'true' },
    });
    if (!res.ok) return { pwned: false, checked: false };
    const body = await res.text();
    for (const line of body.split('\n')) {
      const [suf, countStr] = line.trim().split(':');
      if (suf === suffix) {
        // Padding rows are real hash suffixes with a count of 0 - ignore those.
        return { pwned: (parseInt(countStr, 10) || 0) > 0, checked: true };
      }
    }
    return { pwned: false, checked: true };
  } catch {
    return { pwned: false, checked: false };
  }
}
