import http from 'node:http';
import https from 'node:https';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { config } from './config.js';

export const httpAgent = new http.Agent({ keepAlive: true, maxSockets: Infinity, maxFreeSockets: 512 });
export const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: Infinity, maxFreeSockets: 512 });

const proxyAgents = new Map();
let rr = 0;

function agents() {
  if (!config.proxies.length) return { httpAgent, httpsAgent };
  const p = config.proxies[rr++ % config.proxies.length];
  if (!proxyAgents.has(p)) {
    proxyAgents.set(p, new HttpsProxyAgent(p, { keepAlive: true, maxSockets: Infinity }));
  }
  const a = proxyAgents.get(p);
  return { httpAgent: a, httpsAgent: a };
}

export function client(extra = {}) {
  const { httpAgent: ha, httpsAgent: sa } = agents();
  return axios.create({
    timeout: config.upstream.timeoutMs,
    maxRedirects: 5,
    httpAgent: ha,
    httpsAgent: sa,
    validateStatus: () => true,
    ...extra,
  });
}
