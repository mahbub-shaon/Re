export class QueueFullError extends Error {
  constructor() { super('server busy, queue full'); this.code = 'QUEUE_FULL'; }
}

export class Queue {
  #c; #max; #active = 0; #pending = []; #idle = [];

  constructor({ concurrency, maxQueue }) {
    this.#c = concurrency;
    this.#max = maxQueue;
  }

  get active() { return this.#active; }
  get length() { return this.#pending.length; }

  run(fn) {
    if (this.#active < this.#c && !this.#pending.length) return this.#start(fn);
    if (this.#pending.length >= this.#max) throw new QueueFullError();
    return new Promise((res, rej) => this.#pending.push({ fn, res, rej }));
  }

  async #start(fn) {
    this.#active++;
    try { return await fn(); }
    finally {
      this.#active--;
      this.#next();
      if (!this.#active && !this.#pending.length) this.#idle.splice(0).forEach(r => r());
    }
  }

  #next() {
    if (!this.#pending.length || this.#active >= this.#c) return;
    const j = this.#pending.shift();
    this.#start(j.fn).then(j.res, j.rej);
  }

  idle(ms = 30000) {
    if (!this.#active && !this.#pending.length) return Promise.resolve(true);
    return new Promise(res => {
      const t = setTimeout(() => res(false), ms);
      this.#idle.push(() => { clearTimeout(t); res(true); });
    });
  }
}
