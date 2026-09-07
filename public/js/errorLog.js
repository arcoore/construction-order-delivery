// Best-effort browser error reporting for the beta.
//
// Uncaught errors and unhandled promise rejections are written to the
// `client_errors` Supabase table (insert-only for everyone - see migration
// 0041). No third-party service, no new vendor, no account. The founder
// reads the log from the Supabase dashboard.
//
// Rules this module holds itself to:
//   * Never throw, never block, never retry - a failed report is dropped.
//   * De-dupe within a page load (same error fired in a render loop reports
//     once) and cap the total, so a broken page can't spam the table.
//   * `path` is location.pathname only - never the query string or hash,
//     because a password-recovery link carries its token in the hash.
//   * user_id is set server-side from the JWT (column default), not sent
//     from here.

import { supabase } from './supabaseClient.js';

const APP_VERSION = 'beta';
const MAX_PER_LOAD = 12;

let sent = 0;
const seen = new Set();
let installed = false;

function record(kind, rawMessage, rawStack) {
  try {
    const message = String(rawMessage == null ? 'Unknown error' : rawMessage).slice(0, 2000);
    const stack = rawStack ? String(rawStack).slice(0, 8000) : null;
    const key = kind + '|' + message + '|' + (stack || '').slice(0, 200);
    if (seen.has(key) || sent >= MAX_PER_LOAD) return;
    seen.add(key);
    sent += 1;

    // Fire-and-forget. `.then(ok, err)` with two no-ops so a rejected
    // promise is handled and never becomes an unhandledrejection itself.
    supabase
      .from('client_errors')
      .insert({
        kind,
        message,
        stack,
        path: location.pathname,
        user_agent: (navigator.userAgent || '').slice(0, 500),
        app_version: APP_VERSION,
      })
      .then(() => {}, () => {});
  } catch {
    /* reporting must never make things worse */
  }
}

export function installErrorReporting() {
  if (installed) return;
  installed = true;

  window.addEventListener('error', event => {
    const err = event.error;
    record('error', event.message || (err && err.message), err && err.stack);
  });

  window.addEventListener('unhandledrejection', event => {
    const reason = event.reason;
    record(
      'unhandledrejection',
      (reason && reason.message) || reason,
      reason && reason.stack,
    );
  });
}
