import fsp from 'node:fs/promises';
import path from 'node:path';
import { logger } from './logger.js';
import { NoTokenError } from './util.js';

export { NoTokenError };

export class TokenPool {
  #tokens = new Map();
  #waiters = [];
  #inflight = 0;
  #timer = null;
  #saveTimer = null;
  #chain = Promise.resolve();
  #closed = false;

  constructor(o) {
    this.file = o.file;
    this.target = o.target;
    this.max = o.max;
    this.maxFailures = o.maxFailures;
    this.baseCooldownMs = o.baseCooldownMs;
    this.maxCooldownMs = o.maxCooldownMs;
    this.maxInflight = o.maxInflight;
    this.waitTimeoutMs = o.waitTimeoutMs;
    this.refillIntervalMs = o.refillIntervalMs;
    this.seed = o.seed || [];
    this.registerFn = o.registerFn;
  }

  async init() {
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    try {
      for (const t of JSON.parse(await fsp.readFile(this.file, 'utf8'))) {
        const token = typeof t === 'string' ? t : t?.token;
        if (token) this.#tokens.set(token, this.#blank());
      }
    } catch (e) {
      if (e.code !== 'ENOENT') logger.warn({ err: e.message }, 'token load failed');
    }
    this.seed.forEach(t => this.#tokens.has(t) || this.#tokens.set(t, this.#blank()));
    await this.#save();
    logger.info({ size: this.#tokens.size }, 'pool ready');

    this.#timer = setInterval(() => this.refill(), this.refillIntervalMs);
    this.#timer.unref();
    this.refill();
  }

  #blank() { return { createdAt: Date.now(), lastUsedAt: 0, failures: 0, cooldownUntil: 0, busy: false }; }

  get size() { return this.#tokens.size; }

  add(token) {
    if (!token || this.#tokens.has(token)) return false;
    if (this.#tokens.size >= this.max) {
      const victim = [...this.#tokens.entries()]
        .filter(([, m]) => m.failures > 0 && !m.busy)
        .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)[0];
      if (victim) this.#tokens.delete(victim[0]);
    }
    this.#tokens.set(token, this.#blank());
    this.#scheduleSave();
    this.#drain();
    return true;
  }

  stats() {
    const now = Date.now();
    let ready = 0, cooling = 0, busy = 0;
    for (const m of this.#tokens.values()) {
      if (m.busy) busy++;
      else if (m.cooldownUntil > now) cooling++;
      else if (m.failures < this.maxFailures) ready++;
    }
    return { total: this.#tokens.size, ready, cooling, busy, registering: this.#inflight, waiting: this.#waiters.length };
  }

  #ok(m, now) { return !m.busy && m.failures < this.maxFailures && m.cooldownUntil <= now; }

  #pick(now) {
    let best = null, meta = null;
    for (const [t, m] of this.#tokens) {
      if (!this.#ok(m, now)) continue;
      if (!meta || m.lastUsedAt < meta.lastUsedAt) { best = t; meta = m; }
    }
    if (best) { meta.busy = true; meta.lastUsedAt = now; }
    return best;
  }

  acquire(ms = this.waitTimeoutMs) {
    const hit = this.#pick(Date.now());
    if (hit) return Promise.resolve(hit);
    this.refill();
    return new Promise((res, rej) => {
      const w = { res, rej, t: null };
      w.t = setTimeout(() => {
        this.#waiters = this.#waiters.filter(x => x !== w);
        rej(new NoTokenError());
      }, ms);
      this.#waiters.push(w);
    });
  }

  release(token, ok) {
    const m = this.#tokens.get(token);
    if (!m) return;
    m.busy = false;
    m.lastUsedAt = Date.now();
    if (ok) { m.failures = 0; m.cooldownUntil = 0; }
    else {
      m.failures++;
      m.cooldownUntil = Date.now() + Math.min(this.baseCooldownMs * 2 ** (m.failures - 1), this.maxCooldownMs);
      if (m.failures >= this.maxFailures) this.#tokens.delete(token);
    }
    this.#scheduleSave();
    this.#drain();
  }

  burn(token) {
    if (!this.#tokens.delete(token)) return;
    logger.warn({ left: this.#tokens.size }, 'token burned');
    this.#scheduleSave();
    this.#drain();
    this.refill();
  }

  #drain() {
    while (this.#waiters.length) {
      const t = this.#pick(Date.now());
      if (!t) return;
      const w = this.#waiters.shift();
      clearTimeout(w.t);
      w.res(t);
    }
  }

  refill() {
    if (this.#closed) return;
    const need = this.target - this.#tokens.size - this.#inflight;
    if (need <= 0) return;
    for (let i = 0; i < Math.min(need, this.maxInflight - this.#inflight); i++) this.#register();
  }

  async #register() {
    this.#inflight++;
    try {
      const token = await this.registerFn();
      if (token) this.add(token);
      logger.info({ size: this.#tokens.size }, 'token registered');
    } catch (e) {
      logger.warn({ err: e.message }, 'register failed');
    } finally {
      this.#inflight--;
    }
  }

  #scheduleSave() {
    if (this.#saveTimer) return;
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = null;
      this.#save().catch(() => {});
    }, 1500);
    this.#saveTimer.unref();
  }

  #save() {
    const payload = JSON.stringify([...this.#tokens.keys()]);
    const tmp = `${this.file}.tmp`;
    this.#chain = this.#chain.then(async () => {
      await fsp.writeFile(tmp, payload);
      await fsp.rename(tmp, this.file);
    }).catch(() => {});
    return this.#chain;
  }

  async stop() {
    this.#closed = true;
    clearInterval(this.#timer);
    if (this.#saveTimer) clearTimeout(this.#saveTimer);
    this.#waiters.splice(0).forEach(w => { clearTimeout(w.t); w.rej(new NoTokenError()); });
    await this.#save();
  }
}
