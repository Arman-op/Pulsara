import { randomUUID } from 'node:crypto';
import pinoHttp from 'pino-http';
import { logger } from '../lib/logger';

/**
 * Per-request logging and correlation.
 *
 * Every request is assigned an id, echoed back as `x-request-id` so a user can
 * quote it in a bug report, and attached to `req.log` so downstream handlers log
 * within the same correlated context. Health checks are logged at `debug` to
 * keep container probes from drowning the stream.
 */

const HEALTH_PATH = '/api/health';

export const requestLogger = pinoHttp({
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
