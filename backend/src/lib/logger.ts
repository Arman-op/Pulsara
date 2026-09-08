import pino from 'pino';
import { env, isProduction, isTest } from '../config/env';
import { currentRequestId } from './request-context';

/**
 * Structured application logger.
 *
 * Replaces the previous Winston setup, which emitted JSON to one formatter and
 * colourised plain text to another, so production logs were neither reliably
 * structured nor consistently readable. Pino writes newline-delimited JSON that
 * log aggregators parse directly, and is fast enough to stay on the hot path.
 *
 * Anything that can carry a credential is redacted at the logger, not at the
 * call site, so a future `logger.info({ req })` cannot accidentally leak a
 * bearer token or session cookie.
 */

const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.idToken',
  '*.accessToken',
  '*.refreshToken',
];

export const logger = pino({
  level: isTest ? 'silent' : env.LOG_LEVEL,
  redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
  base: { service: 'pulsara-api' },
  /**
   * Stamps the current request's id onto every line, including the ones written
   * deep inside a service or an alerting engine that never sees a request
   * object.
   *
   * Without this, correlation covered only the two lines pino-http emits, and
   * the lines actually worth finding during an incident — the ones in between —
   * could not be tied to the request that produced them. Work with no request
   * behind it, such as a scheduled probe, correctly carries no id.
   */
  mixin: () => {
    const requestId = currentRequestId();
    return requestId ? { requestId } : {};
  },
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  // Human-readable output locally; raw NDJSON everywhere a collector is reading.
  transport: isProduction
    ? undefined
    : {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,service' },
      },
});

export type Logger = typeof logger;
