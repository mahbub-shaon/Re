import { config } from './config.js';
import { client } from './http.js';
import { sleep, jitter } from './util.js';
import { logger } from './logger.js';

const boxes = new Map(); // email -> { provider, secret }
const NO = 'x'.repeat(12);

function api(timeout = config.mail.timeoutMs) {
  return client({ timeout });
}

/* ---------- mail.tm / mail.gw (same engine, no key) ---------- */
async function createHydra(base) {
  const a = api();
  const dom = await a.get(`${base}/domains`);
  const domain = dom.data?.['hydra:member']?.[0]?.domain;
  if (!domain) throw new Error('no domain');

  const login = `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const address = `${login}@${domain}`;
  const password = `${login}-${NO}`;

  const reg = await a.post(`${base}/accounts`, { address, password });
  if (reg.status >= 400) throw new Error(`account ${reg.status}`);

  const tok = await a.post(`${base}/token`, { address, password });
  const token = tok.data?.token;
  if (!token) throw new Error('no token');

  return { email: address, secret: { base, token } };
}

async function listHydra({ base, token }) {
  const a = api();
  const h = { authorization: `Bearer ${token}` };
  const list = await a.get(`${base}/messages`, { headers: h });
  const items = list.data?.['hydra:member'] || [];
  const out = [];
  for (const m of items.slice(0, 10)) {
    const full = await a.get(`${base}/messages/${m.id}`, { headers: h });
    out.push({ subject: m.subject || '', text: `${full.data?.text || ''}\n${full.data?.html || ''}` });
  }
  return out;
}

/* ---------- 1secmail ---------- */
const SEC = 'https://www.1secmail.com/api/v1/';

async function createSec() {
  const r = await api().get(`${SEC}?action=genRandomMailbox&count=1`);
  const email = Array.isArray(r.data) ? r.data[0] : null;
  if (!email) throw new Error('no mailbox');
  const [login, domain] = email.split('@');
  return { email, secret: { login, domain } };
}

async function listSec({ login, domain }) {
  const a = api();
  const r = await a.get(`${SEC}?action=getMessages&login=${login}&domain=${domain}`);
  const out = [];
  for (const m of (Array.isArray(r.data) ? r.data : []).slice(0, 10)) {
    const full = await a.get(`${SEC}?action=readMessage&login=${login}&domain=${domain}&id=${m.id}`);
    out.push({ subject: full.data?.subject || '', text: `${full.data?.textBody || ''}\n${full.data?.body || ''}` });
  }
  return out;
}

/* ---------- custom ({action} placeholder) ---------- */
function customUrl(base, action, email) {
  let u = base.includes('{action}') ? base.replace('{action}', action)
    : `${base}${base.includes('?') ? '&' : '?'}action=${action}`;
  if (email) u += `&email=${encodeURIComponent(email)}`;
  return u;
}

async function createCustom(base) {
  const r = await api().get(customUrl(base, 'create'));
  const email = r.data?.email || r.data?.data?.email;
  if (!email) throw new Error('no mailbox');
  return { email, secret: { base } };
}

async function listCustom({ base }, email) {
  const r = await api().get(customUrl(base, 'message', email));
  const arr = r.data?.data ?? r.data;
  return (Array.isArray(arr) ? arr : []).map(m => ({
    subject: m.subject || '',
    text: String(m.text_content || m.body || m.text || ''),
  }));
}

/* ---------- dispatch ---------- */
const ORDER = () => {
  const list = [];
  for (const p of config.mail.providers) {
    if (p === 'custom') config.mail.bases.forEach(b => list.push({ p: 'custom', base: b }));
    else if (p === 'mailtm') list.push({ p: 'mailtm' });
    else if (p === 'mailgw') list.push({ p: 'mailgw' });
    else if (p === 'secmail') list.push({ p: 'secmail' });
  }
  return list.length ? list : [{ p: 'mailtm' }];
};

let sticky = null;

export async function createMailbox() {
  const entries = ORDER();
  if (sticky) {
    const i = entries.findIndex(e => e.p === sticky.p && e.base === sticky.base);
    if (i > 0) entries.unshift(entries.splice(i, 1)[0]);
  }

  let lastErr;
  for (const e of entries) {
    try {
      let box;
      if (e.p === 'mailtm') box = await createHydra('https://api.mail.tm');
      else if (e.p === 'mailgw') box = await createHydra('https://api.mail.gw');
      else if (e.p === 'secmail') box = await createSec();
      else box = await createCustom(e.base);

      box.provider = e.p;
      box.base = e.base;
      boxes.set(box.email, box);
      sticky = e;
      logger.debug({ provider: e.p }, 'mailbox created');
      return box.email;
    } catch (err) {
      lastErr = err;
      logger.debug({ provider: e.p, err: err.message }, 'mail provider failed');
    }
  }
  throw new Error(`all mail providers failed: ${lastErr?.message || 'unknown'}`);
}

function extractCode(subject, text) {
  const all = `${subject}\n${text}`.replace(/<[^>]+>/g, ' ');
  if (!/ai.?undress/i.test(all)) return null;
  const near = all.match(/(?:code|otp|verification|verify)[^\d]{0,30}(\d{6})/i);
  if (near) return near[1];
  const any = all.match(/\b(\d{6})\b/);
  return any ? any[1] : null;
}

export async function waitForOtp(email) {
  const box = boxes.get(email);
  if (!box) throw new Error('unknown mailbox');

  const deadline = Date.now() + config.mail.otpWaitMs;
  while (Date.now() < deadline) {
    await sleep(jitter(3000));
    try {
      let msgs;
      if (box.provider === 'mailtm' || box.provider === 'mailgw') msgs = await listHydra(box.secret);
      else if (box.provider === 'secmail') msgs = await listSec(box.secret);
      else msgs = await listCustom(box.secret, email);

      for (const m of msgs) {
        const code = extractCode(m.subject, m.text);
        if (code) { boxes.delete(email); return code; }
      }
    } catch { /* keep polling */ }
  }
  boxes.delete(email);
  throw new Error('OTP timeout');
}

setInterval(() => {
  if (boxes.size > 300) {
    const drop = boxes.size - 300;
    [...boxes.keys()].slice(0, drop).forEach(k => boxes.delete(k));
  }
}, 120000).unref();
