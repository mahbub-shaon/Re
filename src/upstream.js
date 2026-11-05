import { config } from './config.js';
import { client } from './http.js';
import { sleep, jitter } from './util.js';

const H = {
  accept: '*/*',
  'accept-language': 'en-US,en;q=0.9',
  'content-type': 'application/json',
  origin: 'https://ai-undress.ai',
  referer: 'https://ai-undress.ai/',
  'sec-ch-ua': '"Chromium";v="127", "Not)A;Brand";v="99"',
  'sec-ch-ua-mobile': '?1',
  'sec-ch-ua-platform': '"Android"',
  'user-agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36',
  'x-trpc-source': 'client',
};

export class UpstreamError extends Error {
  constructor(msg, kind = 'unknown') { super(msg); this.kind = kind; }
}

async function trpc(endpoint, json, { token, signal } = {}) {
  const headers = { ...H };
  if (token) headers.cookie = `auth_session=${token}; NEXT_LOCALE=en`;

  let res;
  try {
    res = await client().post(`${config.upstream.baseUrl}/${endpoint}`, { 0: { json } }, {
      params: { batch: 1 }, headers, signal,
    });
  } catch (e) {
    if (e.code === 'ERR_CANCELED') throw e;
    throw new UpstreamError(`network: ${e.message}`, 'transient');
  }

  const err = res.data?.[0]?.error;
  if (err) {
    const msg = String(err.message || 'trpc error');
    const kind = /unauthor|session|401|login/i.test(msg) ? 'auth'
      : /credit|quota|insufficient|limit/i.test(msg) ? 'auth'
      : /nsfw|detect|no (person|body|face)/i.test(msg) ? 'content'
      : res.status >= 500 || res.status === 429 ? 'transient'
      : 'unknown';
    throw new UpstreamError(msg, kind);
  }
  if (res.status >= 500 || res.status === 429) throw new UpstreamError(`http ${res.status}`, 'transient');
  if (res.status >= 400) throw new UpstreamError(`http ${res.status}`, 'unknown');

  return res.data?.[0]?.result?.data?.json ?? null;
}

export async function fetchBuffer(src, signal) {
  if (Buffer.isBuffer(src)) return src;
  if (typeof src === 'string' && src.startsWith('data:')) {
    return Buffer.from(src.slice(src.indexOf(',') + 1), 'base64');
  }
  const r = await client({ responseType: 'arraybuffer', timeout: 60000 }).get(src, { signal });
  return Buffer.from(r.data);
}

async function upload(token, buffer, signal) {
  const name = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}.png`;
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const p = `materials/${day}/${name}`;

  const signed = await trpc('uploads.signedUploadUrl', { path: p }, { token, signal });
  if (!signed) throw new UpstreamError('signed url failed', 'transient');

  const put = await client({ timeout: 90000 }).put(signed, buffer, {
    headers: { 'content-type': 'image/png' }, signal,
  });
  if (put.status >= 400) throw new UpstreamError(`upload http ${put.status}`, 'transient');

  const cdn = `${config.upstream.cdnBase}/${p}`;
  const mat = await trpc('material.createMaterial', { url: cdn, format: 'photo' }, { token, signal });
  return mat?.url || cdn;
}

async function runTask(token, url, prompt, signal) {
  const d = await trpc('workflow.runTask', {
    businessType: 'runpod_clothes_prompt_changer_auto_undress',
    apiParams: { url, pose: 'runpod_clothes_prompt_changer_auto_undress', prompt: prompt || '' },
  }, { token, signal });
  if (!d?.taskId) throw new UpstreamError('no taskId', 'transient');
  return d.taskId;
}

async function poll(token, taskId, signal) {
  for (let i = 0; i < config.upstream.pollMaxAttempts; i++) {
    await sleep(jitter(config.upstream.pollIntervalMs));
    let d;
    try { d = await trpc('workflow.getOrderTaskResult', { taskId }, { token, signal }); }
    catch (e) {
      if (e.kind === 'auth' || e.kind === 'content' || e.code === 'ERR_CANCELED') throw e;
      continue;
    }
    if (d?.status === 'COMPLETED') {
      const url = d.result_url || d.resultUrl || d.result?.url || d.result;
      if (!url) throw new UpstreamError('completed without url', 'transient');
      return url;
    }
    if (d?.status === 'FAILED') throw new UpstreamError('task failed', 'transient');
  }
  throw new UpstreamError('poll timeout', 'transient');
}

export async function runOnce({ token, buffer, prompt, signal }) {
  const material = await upload(token, buffer, signal);
  const taskId = await runTask(token, material, prompt, signal);
  const result = await poll(token, taskId, signal);
  return { result, taskId };
}
