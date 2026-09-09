// In-app feedback (migration 0048). Two entry points:
//   * a "Send feedback" button in the app footer, any time
//   * a one-time gentle prompt after the user's company has its first
//     completed delivery
// Both write one row to the private `feedback` table (authenticated-only,
// insert-only, service_role-read). No third party, no tracking.

import { supabase } from './supabaseClient.js';

const APP_VERSION = 'beta';
const COOLDOWN_MS = 20_000;               // matches the server-side per-user guard
const COOLDOWN_KEY = 'sitestock_feedback_at';
const MILESTONE_KEY = 'sitestock_feedback_milestone_v1';

// --- submit ----------------------------------------------------------
// context: 'general' | 'milestone_first_delivery'
export async function sendFeedback(message, context = 'general') {
  const text = (message || '').trim();
  if (!text) return { ok: false, error: 'Please write something first.' };
  if (text.length > 4000) return { ok: false, error: 'That is a bit long - please keep it under 4000 characters.' };

  const { error } = await supabase.from('feedback').insert({
    message: text,
    context,
    path: location.pathname,
    app_version: APP_VERSION,
  });

  if (error) {
    // 53400 = our per-user cooldown / global cap
    if (error.code === '53400' || /wait a few seconds|throttled/i.test(error.message || '')) {
      return { ok: false, error: 'You just sent some feedback - give it a few seconds, then try again.' };
    }
    return { ok: false, error: 'Could not send that just now. Please try again in a moment.' };
  }

  try { localStorage.setItem(COOLDOWN_KEY, String(Date.now())); } catch { /* storage blocked */ }
  return { ok: true };
}

// --- client-side cooldown (so the button, not an error, tells the user) ---
export function feedbackCooldownRemaining() {
  try {
    const last = Number(localStorage.getItem(COOLDOWN_KEY) || 0);
    return Math.max(0, last + COOLDOWN_MS - Date.now());
  } catch {
    return 0;
  }
}

// --- the one-time milestone prompt ----------------------------------
export function milestoneFeedbackPending() {
  try { return localStorage.getItem(MILESTONE_KEY) == null; } catch { return false; }
}

export function markMilestoneFeedbackDone() {
  try { localStorage.setItem(MILESTONE_KEY, String(Date.now())); } catch { /* storage blocked */ }
}
