import { config } from '../src/config.js';
import { TokenPool } from '../src/tokenPool.js';
import { createMailbox, waitForOtp } from '../src/mail.js';
import { client } from '../src/http.js';
import path from 'node:path';
import { logger } from '../src/logger.js';

const n = Number(process.argv[2] || 5);

async function register() {
  const email = await createMailbox();
  await client().post(`${config.upstream.baseUrl}/auth.signup`, {
    0: { json: { email, password: email, callbackUrl: 'https://ai-undress.ai/auth/verify' } },
  }, { params: { batch: 1 }, headers: { 'content-type': 'application/json', origin: 'https://ai-undress.ai', referer: 'https://ai-undress.ai/', 'x-trpc-source': 'client' } });

  const code = await waitForOtp(email);
  const r = await client().post(`${config.upstream.baseUrl}/auth.verifyOtp`, {
    0: { json: { code, type: 'SIGNUP', identifier: email } },
  }, { params: { batch: 1 }, headers: { 'content-type': 'application/json', origin: 'https://ai-undress.ai', referer: 'https://ai-undress.ai/', 'x-trpc-source': 'client' } });

  const id = r.data?.[0]?.result?.data?.json?.id;
  if (!id) throw new Error('no session');
  return id;
}

const pool = new TokenPool({
  file: path.join(config.dataDir, 'tokens.json'),
  target: n, max: config.tokens.max, maxFailures: 3,
  baseCooldownMs: 30000, maxCooldownMs: 600000, maxInflight: 1,
  waitTimeoutMs: 60000, refillIntervalMs: 999999, seed: [], registerFn: register,
});

await pool.init();
logger.info({ target: n }, 'warming');
for (let i = 0; i < n; i++) {
  try { pool.add(await register()); logger.info({ i: i + 1, n }, 'ok'); }
  catch (e) { logger.warn({ err: e.message }, 'fail'); }
}
await pool.stop();
logger.info('warm done');
process.exit(0);
