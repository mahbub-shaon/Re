import pino from 'pino';
import { config } from './config.js';

export const logger = pino({
  level: config.logLevel,
  base: { svc: 'undress' },
  redact: { paths: ['token', '*.token'], censor: '***' },
});
