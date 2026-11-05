import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { logger } from './logger.js';
import { Queue } from './queue.js';
import { TokenPool, NoTokenError } from './tokenPool.js';
import { createMailbox, waitForOtp } from './mail.js';
import { runOnce, fetchBuffer, UpstreamError } from './upstream.js';
import { cacheGet, cacheSet, singleFlight, cacheSize } from './cache.js';
import { isValidImageUrl, cacheKey, sleep, jitter, rid } from './util.js';
import { client } from './http.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ---------- account registration (auto) ---------- */
async function registerAccount() {
  const email = await createMailbox();
  await client().post(`${config.upstream.baseUrl}/auth.signup`, {
    0: { json: { email, password: email, callbackUrl: 'https://ai-undress.ai/auth/verify' } },
  }, { params: { batch: 1 }, headers: trpcHeaders() });

  const code = await waitForOtp(email);
  const r = await client().post(`${config.upstream.baseUrl}/auth.verifyOtp`, {
    0: { json: { code, type: 'SIGNUP', identifier: email } },
  }, { params: { batch: 1 }, headers: trpcHeaders() });

  const id = r.data?.[0]?.result?.data?.json?.id;
  if (!id) throw new Error('verifyOtp: no session id');
  return id;
}

function trpcHeaders() {
  return {
    'content-type': 'application/json',
    origin: 'https://ai-undress.ai',
    referer: 'https://ai-undress.ai/',
    'x-trpc-source': 'client',
    'user-agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36',
  };
}

/* ---------- services ---------- */
const pool = new TokenPool({
  file: path.join(config.dataDir, 'tokens.json'),
  target: config.tokens.target,
  max: config.tokens.max,
  maxFailures: config.tokens.maxFailures,
  baseCooldownMs: config.tokens.baseCooldownMs,
  maxCooldownMs: config.tokens.maxCooldownMs,
  maxInflight: config.tokens.maxInflight,
  waitTimeoutMs: config.tokens.waitTimeoutMs,
  refillIntervalMs: config.tokens.refillIntervalMs,
  seed: config.tokens.seed,
  registerFn: registerAccount,
});

const queue = new Queue({ concurrency: config.limits.concurrency, maxQueue: config.limits.maxQueue });
const ipActive = new Map();

/* ---------- app ---------- */
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '10mb' }));

app.use((req, res, next) => {
  req.rid = req.get('x-request-id') || rid();
  res.setHeader('x-request-id', req.rid);
  res.setHeader('access-control-allow-origin', config.corsOrigin);
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type,x-api-key,x-request-id');
  res.setHeader('access-control-max-age', '86400');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const buckets = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (now - b.start > 120000) buckets.delete(k);
}, 60000).unref();

function rateLimit(req, res, next) {
  if (!config.limits.ratePerMin) return next();
  const ip = req.ip || 'x';
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b || now - b.start > 60000) { b = { start: now, count: 0 }; buckets.set(ip, b); }
  if (++b.count > config.limits.ratePerMin) {
    res.setHeader('retry-after', Math.ceil((60000 - (now - b.start)) / 1000));
    return res.status(429).json({ ok: false, error: 'rate limit exceeded', requestId: req.rid });
  }
  next();
}

function auth(req, res, next) {
  if (!config.apiKey) return next();
  if ((req.get('x-api-key') || req.query.key) !== config.apiKey) {
    return res.status(401).json({ ok: false, error: 'invalid api key', requestId: req.rid });
  }
  next();
}

app.use('/undress', rateLimit, auth);
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));

/* ---------- generation ---------- */
async function generate({ imageUrl, prompt = '', force = false }) {
  const key = cacheKey(imageUrl, prompt);
  if (!force) {
    const hit = cacheGet(key);
    if (hit) return { ...hit, cached: true };
  }

  return singleFlight(key, async () => {
    const t0 = Date.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), config.upstream.requestTimeoutMs);

    try {
      const buffer = await fetchBuffer(imageUrl, ac.signal);
      if (!buffer?.length) throw new UpstreamError('invalid image', 'content');
      if (buffer.length > 25 * 1024 * 1024) throw new UpstreamError('image too large', 'content');

      let lastErr;
      for (let attempt = 1; attempt <= 3; attempt++) {
        let token;
        try {
          token = await pool.acquire();
        } catch {
          // শেষ চেষ্টা: সরাসরি ইনলাইন রেজিস্ট্রেশন
          token = await registerAccount();
        }

        try {
          const out = await runOnce({ token, buffer, prompt, signal: ac.signal });
          pool.release(token, true);
          const payload = { result: out.result, taskId: out.taskId, ms: Date.now() - t0 };
          cacheSet(key, payload);
          return payload;
        } catch (e) {
          lastErr = e;
          if (e.code === 'ERR_CANCELED') { pool.release(token, false); throw e; }
          if (e.kind === 'auth') pool.burn(token);
          else pool.release(token, e.kind !== 'content');
          if (e.kind === 'content') throw e;
          if (attempt < 3) await sleep(jitter(700 * attempt));
        }
      }
      throw lastErr || new UpstreamError('failed', 'unknown');
    } finally {
      clearTimeout(timer);
    }
  });
}

async function handler(req, res) {
  const p = req.method === 'GET' ? req.query : { ...req.query, ...req.body };
  const imageUrl = p.imgurl || p.imageUrl || p.url;
  const prompt = String(p.prompt || '').slice(0, 400);
  const force = /^(1|true|yes)$/i.test(String(p.force || ''));
  const asImage = /^(1|true|yes|image)$/i.test(String(p.proxy || p.format || ''));

  if (!imageUrl) return res.status(400).json({ ok: false, error: "parameter 'imgurl' required", requestId: req.rid });
  if (!isValidImageUrl(imageUrl)) return res.status(400).json({ ok: false, error: 'invalid or private image url', requestId: req.rid });

  const ip = req.ip || 'x';
  const cur = ipActive.get(ip) || 0;
  if (cur >= config.limits.perIpConcurrency) {
    res.setHeader('retry-after', '5');
    return res.status(429).json({ ok: false, error: 'too many parallel requests', requestId: req.rid });
  }
  ipActive.set(ip, cur + 1);

  try {
    const data = await queue.run(() => generate({ imageUrl, prompt, force }));

    if (asImage) {
      const r = await client({ responseType: 'stream', timeout: 60000 }).get(data.result);
      res.setHeader('content-type', r.headers['content-type'] || 'image/jpeg');
      res.setHeader('cache-control', 'public, max-age=86400');
      res.setHeader('x-cached', data.cached ? '1' : '0');
      return r.data.pipe(res);
    }

    return res.json({ ok: true, result: data.result, taskId: data.taskId, ms: data.ms, cached: !!data.cached, pool: pool.stats(), requestId: req.rid });
  } catch (e) {
    if (e.code === 'QUEUE_FULL') { res.setHeader('retry-after', '10'); return res.status(429).json({ ok: false, error: e.message, requestId: req.rid }); }
    if (e.code === 'NO_TOKEN') { res.setHeader('retry-after', '15'); return res.status(503).json({ ok: false, error: 'sessions exhausted, retry shortly', requestId: req.rid }); }
    const status = e.code === 'ERR_CANCELED' ? 504 : e.kind === 'content' ? 422 : 502;
    logger.warn({ rid: req.rid, err: e.message, kind: e.kind }, 'generate failed');
    return res.status(status).json({ ok: false, error: e.message, requestId: req.rid });
  } finally {
    const n = (ipActive.get(ip) || 1) - 1;
    n <= 0 ? ipActive.delete(ip) : ipActive.set(ip, n);
  }
}

app.all('/undress', handler);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
app.post('/undress-upload', rateLimit, auth, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'field "image" required', requestId: req.rid });
  req.query.imgurl = `data:${req.file.mimetype || 'image/png'};base64,${req.file.buffer.toString('base64')}`;
  return handler(req, res);
});

app.get('/proxy', async (req, res) => {
  const url = String(req.query.url || '');
  if (!url.startsWith('http') || !isValidImageUrl(url)) {
    return res.status(400).json({ ok: false, error: 'invalid url' });
  }
  try {
    const r = await client({ responseType: 'stream', timeout: 60000 }).get(url);
    res.setHeader('content-type', r.headers['content-type'] || 'image/jpeg');
    res.setHeader('cache-control', 'public, max-age=86400');
    r.data.pipe(res);
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

/* ---------- ops ---------- */
app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime(), pool: pool.stats(), queue: { active: queue.active, waiting: queue.length } }));
app.get('/stats', (req, res) => res.json({ ok: true, pool: pool.stats(), queue: { active: queue.active, waiting: queue.length }, cache: cacheSize(), rss: process.memoryUsage().rss }));

app.get('/admin/tokens', auth, (req, res) => res.json({ ok: true, pool: pool.stats() }));
app.post('/admin/tokens', auth, (req, res) => {
  const arr = Array.isArray(req.body?.tokens) ? req.body.tokens : [req.body?.token];
  const added = arr.filter(Boolean).filter(t => pool.add(String(t))).length;
  res.json({ ok: true, added, pool: pool.stats() });
});

app.use((req, res) => res.status(404).json({ ok: false, error: 'not found' }));
app.use((err, req, res, _next) => {
  logger.error({ rid: req.rid, err: err.message }, 'unhandled');
  res.status(500).json({ ok: false, error: 'internal error', requestId: req.rid });
});

/* ---------- boot ---------- */
let down = false;

async function main() {
  await pool.init();
  const server = app.listen(config.port, config.host, () => logger.info({ port: config.port }, 'listening'));
  server.keepAliveTimeout = 120000;
  server.headersTimeout = 125000;

  const shutdown = async (sig) => {
    if (down) return;
    down = true;
    logger.info({ sig }, 'shutting down');
    server.close();
    await queue.idle(30000);
    await pool.stop();
    process.exit(0);
  };
  ['SIGINT', 'SIGTERM'].forEach(s => process.on(s, () => shutdown(s)));
  process.on('unhandledRejection', e => logger.error({ err: e?.message || String(e) }, 'unhandledRejection'));
  process.on('uncaughtException', e => logger.error({ err: e.message, stack: e.stack }, 'uncaughtException'));
}

main().catch(e => { logger.error({ err: e.message }, 'boot failed'); process.exit(1); });
