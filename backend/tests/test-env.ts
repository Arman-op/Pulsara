/**
 * The environment the test process runs under.
 *
 * `src/config/env.ts` validates `process.env` at import time and exits the
 * process if anything is missing, so these values have to be in place before
 * any application module is loaded. That is why this file is imported by both
 * the Vitest global setup and the per-file setup, and why it does its work as a
 * side effect of import rather than exporting a function somebody might forget
 * to call.
 *
 * Values are assigned unconditionally rather than filled in as defaults.
 * Vitest loads `.env` into `process.env` before setup files run, so a developer
 * whose local `.env` happened to set `CORS_ORIGINS` to a different port, or a
 * tighter rate limit, would otherwise see assertions fail for reasons that have
 * nothing to do with their change. The suite defines its own environment; the
 * one variable that legitimately varies between machines is the database, and
 * it comes in as `TEST_DATABASE_URL`.
 */

/**
 * The suffix a database must carry before the tests will touch it.
 *
 * Integration tests truncate every table between cases. Pointing them at a
 * development database would silently destroy that developer's data, so the
 * name is checked rather than trusted.
 */
export const REQUIRED_DATABASE_SUFFIX = '_test';

/**
 * Matches the PostgreSQL container in docker-compose.yml, which publishes on
 * 5433 rather than 5432 to avoid clashing with a native install.
 */
const DEFAULT_TEST_DATABASE_URL =
  'postgresql://pulsara:pulsara_local_dev@localhost:5433/pulsara_test';

export const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;

const databaseName = new URL(testDatabaseUrl).pathname.replace(/^\//, '');

if (!databaseName.endsWith(REQUIRED_DATABASE_SUFFIX)) {
  throw new Error(
    `Refusing to run tests against database "${databaseName}": the test suite truncates every ` +
      `table between cases, so its database name must end in "${REQUIRED_DATABASE_SUFFIX}". ` +
      `Set TEST_DATABASE_URL to a dedicated database.`,
  );
}

/** The origin the CORS assertions use. */
export const TEST_ORIGIN = 'http://localhost:5173';

/** A fixed secret, so webhook signatures in the fixtures are reproducible. */
export const TEST_WEBHOOK_SECRET = 'test_webhook_secret_0123456789abcdef';

const TEST_ENVIRONMENT: Record<string, string> = {
  NODE_ENV: 'test',
  DATABASE_URL: testDatabaseUrl,
  LOG_LEVEL: 'fatal',
  CORS_ORIGINS: TEST_ORIGIN,

  /**
   * Distinct, long enough, and not on the forbidden-placeholder list — these go
   * through exactly the validation production keys do.
   */
  JWT_ACCESS_SECRET: 'test_access_secret_0123456789abcdefghijkl',
  JWT_REFRESH_SECRET: 'test_refresh_secret_0123456789abcdefghijkl',

  /**
   * Background work is switched off. The collector and the probe scheduler are
   * started by `server.ts`, which the tests never import, but leaving these on
   * would mean any test that did would start writing rows on a timer.
   */
  METRICS_COLLECTION_ENABLED: 'false',
  PROBES_ENABLED: 'false',
  GITHUB_SYNC_ENABLED: 'false',

  /** Deterministic alert thresholds, so the assertions state real numbers. */
  HOST_ALERTS_ENABLED: 'true',
  CPU_ALERT_THRESHOLD_PERCENT: '90',
  MEMORY_ALERT_THRESHOLD_PERCENT: '90',
  DISK_ALERT_THRESHOLD_PERCENT: '85',
  HOST_ALERT_CRITICAL_PERCENT: '97',
  HOST_ALERT_SUSTAINED_SAMPLES: '3',
  HOST_ALERT_RECOVERY_SAMPLES: '5',

  PROMETHEUS_METRICS_ENABLED: 'true',

  /** Deterministic delivery-alert thresholds. */
  DEPLOYMENT_ALERTS_ENABLED: 'true',
  DEPLOYMENT_FAILURE_ESCALATION_RUNS: '3',

  /**
   * The rate limiters are sized for humans. A test file makes hundreds of
   * requests from one address within a second and would trip them.
   */
  RATE_LIMIT_MAX_REQUESTS: '100000',
  AUTH_RATE_LIMIT_MAX_ATTEMPTS: '1000',

  GITHUB_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,

  /** Deterministic thresholds, so the hysteresis assertions state real numbers. */
  SERVICE_FAILURE_THRESHOLD: '3',
  SERVICE_RECOVERY_THRESHOLD: '2',
  SERVICE_DEGRADED_LATENCY_MS: '1000',
};

for (const [key, value] of Object.entries(TEST_ENVIRONMENT)) {
  process.env[key] = value;
}

/**
 * Federated sign-in is all-or-nothing in the schema, and the tests exercise the
 * password path, so any Firebase credentials a developer has locally are
 * cleared rather than half-applied.
 */
for (const key of ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY']) {
  delete process.env[key];
}

/** No token, so the polling sync stays off and nothing reaches api.github.com. */
delete process.env.GITHUB_TOKEN;

/**
 * The scrape endpoint is exercised both open and protected; the protected case
 * sets this itself, so the default has to be genuinely absent rather than
 * whatever a developer's `.env` happens to carry.
 */
delete process.env.METRICS_SCRAPE_TOKEN;

/**
 * Removed in the observability change. Deleting it here means a developer whose
 * `.env` predates the rename still gets a passing suite, and finds out about the
 * rename from the server's startup error rather than from a confusing test run.
 */
delete process.env.METRICS_COLLECTION_INTERVAL_MS;
