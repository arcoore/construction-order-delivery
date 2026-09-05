// Per-order message threads (migration 0037). Same synchronous-facade-over-
// async-cache shape as orderLifecycle.js's event cache: getMessagesForOrder
// is synchronous over an in-memory cache of every message the current user
// can see (RLS-scoped); sendMessage is genuinely async (send_order_message
// RPC). refreshMessageCache is wired into auth transitions, view entry, and
// the Realtime community channel (realtime.js).
import { supabase } from './supabaseClient.js';
import { subscribeAuth } from './auth.js';
import { getCurrentUserId, primeProfiles } from './identity.js';

const listeners = new Set();
function notify() { listeners.forEach(fn => fn()); }
export function subscribeOrderMessages(fn) { listeners.add(fn); fn(); return () => listeners.delete(fn); }

let cache = [];
export let orderMessagesCacheReady = false;

function mapRow(r) {
  return {
    id: r.id,
    orderId: r.order_id,
    communityId: r.community_id,
    authorId: r.author_id,
    authorName: r.author_name,
    body: r.body,
    createdAt: new Date(r.created_at).getTime(),
  };
}

export async function refreshMessageCache() {
  if (!getCurrentUserId()) {
    cache = [];
    orderMessagesCacheReady = true;
    notify();
    return;
  }
  const { data, error } = await supabase
    .from('order_messages')
    .select('*')
    .order('created_at', { ascending: true });
  if (!error && data) {
    cache = data.map(mapRow);
    const ids = [...new Set(cache.map(m => m.authorId))];
    if (ids.length) {
      const { data: profiles } = await supabase.from('profiles').select('id, display_name').in('id', ids);
      if (profiles) primeProfiles(profiles);
    }
  }
  orderMessagesCacheReady = true;
  notify();
}

subscribeAuth(() => { refreshMessageCache(); });

export function getMessagesForOrder(orderId) {
  return cache.filter(m => m.orderId === orderId).sort((a, b) => a.createdAt - b.createdAt);
}

export function getMessageCountForOrder(orderId) {
  return cache.reduce((n, m) => n + (m.orderId === orderId ? 1 : 0), 0);
}

export async function sendMessage(orderId, body) {
  const { data, error } = await supabase.rpc('send_order_message', { p_order_id: orderId, p_body: body });
  if (error) return { ok: false, error: error.message };
  const msg = mapRow(data);
  if (!cache.some(m => m.id === msg.id)) cache.push(msg);
  notify();
  return { ok: true, message: msg };
}
