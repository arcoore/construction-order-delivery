// Roadmap Step 2 — pure helpers for the Worker-facing "Needed by" deadline
// feature. No DOM, no Supabase — same small pure-function shape as geo.js,
// imported identically by site.js/owner.js/buyer.js/driver.js so every role
// formats a deadline the exact same way.
//
// The fixed same-day/next-day 17:00 cutoff is a deliberate UI shortcut
// only. The database's neededByType only ever stores 'asap' or 'deadline'
// (see orderLifecycle.js/migrations/0019) — never 'today'/'tomorrow' — so
// every function here that produces a label recomputes it fresh from the
// real stored timestamp, never from which shortcut button was originally
// tapped. That's what stops an order created "for tomorrow" from still
// saying "Tomorrow" once that's no longer true.

export const DEADLINE_CUTOFF_HOUR = 17; // 5:00 PM local — a construction-relevant end-of-working-day cutoff, not derived from anything more precise.

// Today's fixed cutoff as a real Date, in the browser's local timezone.
// setHours operates on the local calendar date `d` already holds, so this
// is DST-safe without any manual UTC-offset math.
export function todayDeadlineDate() {
  const d = new Date();
  d.setHours(DEADLINE_CUTOFF_HOUR, 0, 0, 0);
  return d;
}

// Tomorrow's fixed cutoff — setDate happens BEFORE setHours so month/year
// rollover and any DST-transition day resolve correctly at the local
// calendar level, never a raw +24h millisecond addition (which would be
// wrong on the two days a year the UK clocks change).
export function tomorrowDeadlineDate() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(DEADLINE_CUTOFF_HOUR, 0, 0, 0);
  return d;
}

// "Today" is only ever offered while its resulting deadline is still
// genuinely in the future — never silently rolled into tomorrow once the
// cutoff has passed.
export function isTodayDeadlineAvailable() {
  return todayDeadlineDate().getTime() > Date.now();
}

// The one fixed clock time Today/Tomorrow share, for button labels like
// "Today · by 5:00 PM" — derived from the real cutoff Date, never a
// hand-typed string, so it can never drift out of sync with the actual
// resolved deadline.
export function cutoffTimeLabel() {
  return todayDeadlineDate().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// <input type="datetime-local"> value -> Date. The input's value has no
// timezone of its own (local wall-clock text); `new Date(value)` parses it
// as local time, matching the browser's own timezone — the same
// interpretation driver.js's deliverOrder already relies on for its own
// datetime-local field.
export function datetimeLocalToDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// The reverse conversion, for pre-filling a datetime-local input from an
// existing stored value — the input wants "YYYY-MM-DDTHH:mm" in LOCAL time,
// never ISO/UTC.
export function dateToDatetimeLocalValue(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function isSameLocalDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// The single shared display formatter. neededByMs is the order's
// neededBy field (epoch ms, or null) as orderLifecycle.js already maps it.
// Today/Tomorrow labels are computed fresh against the CURRENT date every
// time this runs, never stored or cached — an order created "for tomorrow"
// and viewed two days later correctly falls through to the plain
// absolute-date format instead of still saying "Tomorrow". A past deadline
// is still shown honestly (today/tomorrow/absolute, whichever is
// literally true) — deliberately no "overdue"/"at risk" wording or styling
// this phase.
export function formatNeededBy(neededByType, neededByMs) {
  if (neededByType === 'asap') return 'ASAP';
  if (neededByType !== 'deadline' || neededByMs == null) return 'Not specified';

  const d = new Date(neededByMs);
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  if (isSameLocalDay(d, now)) return `Today, ${time}`;
  if (isSameLocalDay(d, tomorrow)) return `Tomorrow, ${time}`;
  const datePart = d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  return `${datePart}, ${time}`;
}
