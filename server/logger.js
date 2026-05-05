import pino from 'pino';
import { config } from './config.js';

const REDACT_PATHS = [
  'req.headers["x-csrf-token"]',
  'req.headers.cookie',
  'req.headers.authorization',
  '*.password',
  '*.token',
  '*.token_hash',
  '*.code',
];

function buildLogger() {
  if (config.isTest) {
    return pino({ level: 'silent' });
  }
  if (config.isProd) {
    return pino({ level: config.logLevel, redact: { paths: REDACT_PATHS, censor: '[redacted]' } });
  }
  return pino({
    level: config.logLevel,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' },
    },
  });
}

export const logger = buildLogger();
