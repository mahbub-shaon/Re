import crypto from 'node:crypto';

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
export const jitter = (ms) => Math.floor(ms * (0.6 + Math.random() * 0.8));
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const rid = () => crypto.randomBytes(6).toString('hex');

const PRIVATE = /^(localhost$|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.)/i;

export function isValidImageUrl(u) {
  if (typeof u !== 'string' || !u) return false;
  if (u.startsWith('data:image/')) return true;
  try {
    const url = new URL(u);
    if (!/^https?:$/.test(url.protocol)) return false;
    return !PRIVATE.test(url.hostname);
  } catch { return false; }
}

export const cacheKey = (img, prompt) => sha256(`${img}|${prompt || ''}`);

export class QueueFullError extends Error {
  constructor() { super('server busy, queue full'); this.code = 'QUEUE_FULL'; }
}
export class NoTokenError extends Error {
  constructor() { super('no session available'); this.code = 'NO_TOKEN'; }
}
