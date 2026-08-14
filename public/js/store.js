// Orders are persisted in localStorage and synced live across browser tabs
// (e.g. one tab acting as "Site", another as "Driver") via the storage event.
//
// Bumped to v4 for Phase 4A (mandatory siteId + historical site snapshot on
// every order) — a clean reset, old local/test data intentionally discarded
// rather than migrated, matching every prior structural change to this key.
const STORAGE_KEY = 'sitestock_orders_v4';
const listeners = new Set();

function readOrders() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function writeOrders(orders) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(orders));
  notify();
}

function notify() {
  const orders = readOrders();
  listeners.forEach(fn => fn(orders));
}

window.addEventListener('storage', e => {
  if (e.key === STORAGE_KEY) notify();
});

export function subscribe(fn) {
  listeners.add(fn);
  fn(readOrders());
  return () => listeners.delete(fn);
}

export function getOrders() {
  return readOrders();
}

export function addOrder(order) {
  const orders = readOrders();
  orders.push(order);
  writeOrders(orders);
}

export function updateOrder(id, patch) {
  const orders = readOrders();
  const idx = orders.findIndex(o => o.id === id);
  if (idx === -1) return;
  orders[idx] = { ...orders[idx], ...patch };
  writeOrders(orders);
}

export function newId() {
  return (crypto.randomUUID ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}
