import 'dotenv/config';
import path from 'node:path';

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const list = (v) => String(v || '').split(',').map(s => s.trim()).filter(Boolean);

export const config = {
  port: num(process.env.PORT, 8787),
  host: process.env.HOST || '0.0.0.0',
  apiKey: process.env.API_KEY || '',
  dataDir: path.resolve(process.env.DATA_DIR || './data'),
  corsOrigin: process.env.CORS_ORIGIN || '*',
  logLevel: process.env.LOG_LEVEL || 'info',
  proxies: list(process.env.PROXIES),

  upstream: {
    baseUrl: process.env.UPSTREAM_BASE || 'https://ai-undress.ai/api/trpc',
    cdnBase: (process.env.CDN_BASE || 'https://cdn.ai-undress.ai').replace(/\/$/, ''),
    timeoutMs: num(process.env.UPSTREAM_TIMEOUT_MS, 45000),
    pollIntervalMs: num(process.env.POLL_INTERVAL_MS, 3000),
    pollMaxAttempts: num(process.env.POLL_MAX_ATTEMPTS, 80),
    requestTimeoutMs: num(process.env.REQUEST_TIMEOUT_MS, 300000),
  },

  mail: {
    providers: list(process.env.MAIL_PROVIDERS) .length
      ? list(process.env.MAIL_PROVIDERS)
      : ['mailtm', 'mailgw', 'secmail'],
    bases: list(process.env.MAIL_API_BASES),
    timeoutMs: num(process.env.MAIL_TIMEOUT_MS, 20000),
    otpWaitMs: num(process.env.OTP_WAIT_MS, 120000),
  },

  tokens: {
    seed: list(process.env.TOKENS),
    target: num(process.env.TARGET_TOKENS, 10),
    max: num(process.env.MAX_TOKENS, 150),
    maxInflight: num(process.env.MAX_REGISTER_INFLIGHT, 2),
    maxFailures: num(process.env.TOKEN_MAX_FAILURES, 3),
    baseCooldownMs: num(process.env.TOKEN_BASE_COOLDOWN_MS, 30000),
    maxCooldownMs: num(process.env.TOKEN_MAX_COOLDOWN_MS, 600000),
    refillIntervalMs: num(process.env.REFILL_INTERVAL_MS, 15000),
    waitTimeoutMs: num(process.env.WAIT_TOKEN_TIMEOUT_MS, 60000),
  },

  limits: {
    concurrency: num(process.env.CONCURRENCY, 6),
    maxQueue: num(process.env.MAX_QUEUE, 300),
    perIpConcurrency: num(process.env.PER_IP_CONCURRENCY, 3),
    ratePerMin: num(process.env.RATE_LIMIT_PER_MIN, 30),
  },

  cache: {
    ttlMs: num(process.env.CACHE_TTL_MS, 6 * 3600 * 1000),
    max: num(process.env.CACHE_MAX, 2000),
  },
};
