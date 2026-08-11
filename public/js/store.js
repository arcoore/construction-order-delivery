// Orders are persisted in localStorage and synced live across browser tabs
// (e.g. one tab acting as "Site", another as "Driver") via the storage event.
const STORAGE_KEY = 'sitestock_orders_v1';
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
