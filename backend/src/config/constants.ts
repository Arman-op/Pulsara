/**
 * Fixed, non-environment-specific values.
 *
 * Anything that legitimately differs between a laptop, CI and production lives
 * in `env.ts` instead. What remains here are protocol- and product-level
 * constants that are the same everywhere, named so that no bare number ever
 * appears at a call site.
 */

/** Duration helpers, so call sites read as units rather than digit soup. */
export const MS_PER_SECOND = 1_000;
export const SECONDS_PER_MINUTE = 60;
export const MINUTES_PER_HOUR = 60;
export const HOURS_PER_DAY = 24;
export const MS_PER_MINUTE = MS_PER_SECOND * SECONDS_PER_MINUTE;
export const MS_PER_HOUR = MS_PER_MINUTE * MINUTES_PER_HOUR;
export const MS_PER_DAY = MS_PER_HOUR * HOURS_PER_DAY;

/** Every HTTP route is mounted beneath this prefix. */
export const API_PREFIX = '/api';

/**
 * Request bodies are small JSON documents. Capping the parser well below any
 * realistic payload turns an oversized-body attack into a cheap 413 instead of
 * heap pressure.
 */
export const MAX_REQUEST_BODY_BYTES = 64 * 1024;

/**
 * Webhook payloads are much larger than API requests: a GitHub `workflow_run`
 * event embeds the full repository and commit objects. It gets its own cap so
 * that raising it does not also raise the limit on every authenticated route.
 */
export const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

/**
 * The refresh token is delivered as an HttpOnly cookie so that it is not
 * reachable from JavaScript, which is what makes it safe to be long-lived.
 */
export const REFRESH_TOKEN_COOKIE = 'pulsara_refresh_token';

/**
 * How long to let in-flight requests finish after SIGTERM before forcing exit.
 * Kept under the orchestrator's default kill timeout so shutdown stays graceful.
 */
export const SHUTDOWN_GRACE_PERIOD_MS = 10 * MS_PER_SECOND;
