import { config } from './config.js';

const store = new Map();
const inflight = new Map();

export function cacheGet(k) {
  const e = store.get(k);
  if (!e) return null;
  if (Date.now() > e.exp) { store.delete(k); return null; }
  return e.value;
}

export function cacheSet(k, v) {
  if (!config.cache.ttlMs) return;
  if (store.size >= config.cache.max) {
    const oldest = store.keys().next().value;
    if (oldest) store.delete(oldest);
  }
  store.set(k, { value: v, exp: Date.now() + config.cache.ttlMs });
}

export function singleFlight(k, fn) {
  const hit = inflight.get(k);
  if (hit) return hit;
  const p = fn().finally(() => inflight.delete(k));
  inflight.set(k, p);
  return p;
}

export const cacheSize = () => store.size;

setInterval(() => {
  const now = Date.now();
  for (const [k, e] of store) if (now > e.exp) store.delete(k);
}, 60000).unref();
