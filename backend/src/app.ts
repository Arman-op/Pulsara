import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { API_PREFIX, MAX_REQUEST_BODY_BYTES, MAX_WEBHOOK_BODY_BYTES } from './config/constants';
import { env, isProduction } from './config/env';
import { ForbiddenError } from './lib/errors';
import { errorHandler } from './middleware/errorHandler';
import { notFound } from './middleware/notFound';
import { requestLogger } from './middleware/requestLogger';
import authRoutes from './modules/auth/auth.routes';
import githubRoutes from './modules/github/github.routes';
import githubWebhookRoutes from './modules/github/github.webhook.routes';
import deploymentRoutes from './modules/deployments/deployments.routes';
import healthRoutes from './modules/health/health.routes';
import incidentRoutes from './modules/incidents/incidents.routes';
import serviceRoutes from './modules/services/services.routes';
import telemetryRoutes from './modules/telemetry/telemetry.routes';
import userRoutes from './modules/users/users.routes';

export const app = express();

/**
 * Behind a load balancer the socket address is the proxy, not the client, so
 * the rate limiter would bucket every user together. Trusting exactly one hop
 * makes `req.ip` the real client while still refusing a spoofed
 * `X-Forwarded-For` chain from the open internet.
 */
if (isProduction) {
  app.set('trust proxy', 1);
}

app.disable('x-powered-by');

app.use(
  helmet({
    // The API serves JSON only and is consumed cross-origin by the SPA, so the
    // default same-origin resource policy would block legitimate reads.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }),
);

/**
 * CORS is an explicit allowlist rather than a single origin string, because a
 * deployment commonly serves an apex domain and a preview domain at once.
 * Requests with no `Origin` header (server-to-server, curl, health probes) are
 * permitted; the browser is the only party the header protects.
 */
const allowedOrigins = new Set(env.CORS_ORIGINS);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin)) {
        callback(null, true);
        return;
      }
      callback(new ForbiddenError(`Origin ${origin} is not permitted`));
    },
    credentials: true,
  }),
);

app.use(
  rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    limit: env.RATE_LIMIT_MAX_REQUESTS,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: {
      success: false,
      error: { code: 'RATE_LIMITED', message: 'Too many requests; please retry shortly' },
    },
  }),
);

/**
 * The GitHub webhook is mounted BEFORE the JSON parser, with a raw-body parser
 * of its own.
 *
 * Its signature is an HMAC over the exact bytes GitHub sent. Once
 * `express.json()` has consumed the stream, those bytes are gone, and
 * re-serialising the parsed object does not reproduce them: key order, unicode
 * escaping and whitespace all differ. Verifying against a re-serialised body
 * would reject valid deliveries, and the usual "fix" for that is to stop
 * verifying — so the ordering here is a security property, not a preference.
 *
 * Webhook payloads are larger than API requests (a workflow_run event carries
 * the full repository object), hence its own size cap.
 */
app.use(
  `${API_PREFIX}/integrations/github/webhook`,
  express.raw({ type: '*/*', limit: MAX_WEBHOOK_BODY_BYTES }),
  githubWebhookRoutes,
);

app.use(express.json({ limit: MAX_REQUEST_BODY_BYTES }));
app.use(express.urlencoded({ extended: false, limit: MAX_REQUEST_BODY_BYTES }));
app.use(cookieParser());
app.use(requestLogger);

app.use(`${API_PREFIX}/health`, healthRoutes);
app.use(`${API_PREFIX}/auth`, authRoutes);
app.use(`${API_PREFIX}/deployments`, deploymentRoutes);
app.use(`${API_PREFIX}/services`, serviceRoutes);
app.use(`${API_PREFIX}/incidents`, incidentRoutes);
app.use(`${API_PREFIX}/metrics`, telemetryRoutes);
app.use(`${API_PREFIX}/integrations/github`, githubRoutes);
app.use(`${API_PREFIX}/users`, userRoutes);

app.use(notFound);
app.use(errorHandler);
