// Global kill switch / maintenance flag (see migration 0042).
//
// Reads the single `app_status` row. main.js calls refreshAppStatus() during
// bootstrap and on window focus; if getAppStatus().killed is true it shows a
// full-screen maintenance message instead of routing into the app.
//
// FAILS OPEN: any read error leaves the cached status untouched (default:
// not killed), so a transient Supabase problem never locks everyone out.
// The flag is flipped by the founder from the Supabase dashboard - there is
// deliberately no client write path.

import { supabase } from './supabaseClient.js';

let status = { killed: false, message: '' };

export function getAppStatus() {
  return status;
}

export async function refreshAppStatus() {
  try {
    const { data, error } = await supabase
      .from('app_status')
      .select('killed, message')
      .eq('id', 1)
      .single();
    if (!error && data) {
      status = { killed: !!data.killed, message: data.message || '' };
    }
  } catch {
    /* fail open - keep the last known (or default) status */
  }
  return status;
}
