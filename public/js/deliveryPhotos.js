// Delivery photo proof (migration 0039). A small cache of delivery_photos
// rows the current user can see (RLS-scoped), plus upload + signed-URL
// helpers. Same shape as orderMessages.js.
import { supabase } from './supabaseClient.js';
import { subscribeAuth } from './auth.js';
import { getCurrentUserId } from './identity.js';

const BUCKET = 'delivery-photos';

const listeners = new Set();
function notify() { listeners.forEach(fn => fn()); }
export function subscribeDeliveryPhotos(fn) { listeners.add(fn); fn(); return () => listeners.delete(fn); }

let cache = [];

function mapRow(r) {
  return {
    id: r.id,
    orderId: r.order_id,
    storagePath: r.storage_path,
    uploadedById: r.uploaded_by_id,
    uploadedAt: new Date(r.uploaded_at).getTime(),
  };
}

export async function refreshPhotoCache() {
  if (!getCurrentUserId()) { cache = []; notify(); return; }
  const { data, error } = await supabase.from('delivery_photos').select('*').order('uploaded_at', { ascending: true });
  if (!error && data) cache = data.map(mapRow);
  notify();
}

subscribeAuth(() => { refreshPhotoCache(); });

export function getPhotosForOrder(orderId) {
  return cache.filter(p => p.orderId === orderId);
}

export function getPhotoCountForOrder(orderId) {
  return cache.reduce((n, p) => n + (p.orderId === orderId ? 1 : 0), 0);
}

// Upload one File to <orderId>/<uuid>.<ext>, then record it. Returns
// { ok, error }. The storage.objects INSERT policy (0039) independently
// re-checks that the caller is the assigned driver.
export async function uploadDeliveryPhoto(orderId, file) {
  if (!file || !file.type || !file.type.startsWith('image/')) {
    return { ok: false, error: 'Only image files can be attached.' };
  }
  if (file.size > 10 * 1024 * 1024) {
    return { ok: false, error: 'That image is over 10 MB — please use a smaller one.' };
  }
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
  const path = `${orderId}/${crypto.randomUUID()}.${ext}`;

  const up = await supabase.storage.from(BUCKET).upload(path, file, { contentType: file.type, upsert: false });
  if (up.error) return { ok: false, error: up.error.message };

  const rec = await supabase.rpc('add_delivery_photo', { p_order_id: orderId, p_storage_path: path });
  if (rec.error) {
    // best-effort cleanup of the orphaned object (delete policy allows it
    // while unrecorded)
    await supabase.storage.from(BUCKET).remove([path]);
    return { ok: false, error: rec.error.message };
  }
  cache.push(mapRow(rec.data));
  notify();
  return { ok: true };
}

const signedUrlCache = new Map(); // path -> { url, expires }
export async function signedUrlFor(path) {
  const hit = signedUrlCache.get(path);
  if (hit && hit.expires > Date.now() + 30_000) return hit.url;
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 3600);
  if (error || !data) return null;
  signedUrlCache.set(path, { url: data.signedUrl, expires: Date.now() + 3600_000 });
  return data.signedUrl;
}
