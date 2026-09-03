import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import pinoHttp from 'pino-http';
import { logger } from '../lib/logger';
import { runWithRequestContext } from '../lib/request-context';

/**
 * Per-request logging and correlation.
 *
 * Every request is assigned an id, echoed back as `x-request-id` so a user can
 * quote it in a bug report, and attached to `req.log` so downstream handlers log
 * within the same correlated context. Health checks are logged at `debug` to
 * keep container probes from drowning the stream.
 */

const HEALTH_PATH = '/api/health';

const httpLogger = pinoHttp({
  logger,
  genReqId: (req, res) => {
    const existing = req.headers['x-request-id'];
    const id = typeof existing === 'string' && existing.length > 0 ? existing : randomUUID();
    res.setHeader('x-request-id', id);
    return id;
  },
  customLogLevel: (req, res, err) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    if (req.url === HEALTH_PATH) return 'debug';
    return 'info';
  },
  customSuccessMessage: (req, res) => `${req.method} ${req.url} ${res.statusCode}`,
  customErrorMessage: (req, res, err) =>
    `${req.method} ${req.url} ${res.statusCode} ${err.message}`,
});

/**
 * Assigns the id, then runs the rest of the request inside a context carrying
 * it, so every log line the request produces is stamped with it — not only the
 * two pino-http writes itself.
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  httpLogger(req, res);

  /**
   * `genReqId` above always returns a string, but pino-http types `req.id` as
   * the wider `ReqId`, so it is narrowed rather than coerced — stringifying an
   * object would silently produce "[object Object]" as a correlation id.
   */
  const { id } = req;
  runWithRequestContext({ requestId: typeof id === 'string' ? id : String(Number(id)) }, next);
}
