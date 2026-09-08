import { Prisma } from '@prisma/client';
import { MS_PER_HOUR } from '../../config/constants';
import { env } from '../../config/env';
import { prisma } from '../../db/prisma';

/**
 * Derived telemetry.
 *
 * Health figures are computed from stored observations at read time rather than
 * kept in denormalised columns on `Service`. A cached percentage can drift from
 * the results it claims to summarise, and this product's whole value rests on
 * not showing a number nobody measured. The composite index on
 * `(serviceId, checkedAt DESC)` makes the aggregate a range scan.
 *
 * If the observation count ever outgrows that, the scaling path is a rollup
 * table maintained by the scheduler — not a column updated in two places.
 */

export type ServiceHealth = {
  /** Successful checks as a percentage of all checks in the window. */
  uptimePercent: number | null;
  /** Median latency of successful checks, in milliseconds. */
  latencyP50Ms: number | null;
  /**
   * 95th percentile latency. Reported alongside the median because an average
   * hides exactly the tail that users actually feel.
   */
  latencyP95Ms: number | null;
  /** Latency of the most recent successful check. */
  lastLatencyMs: number | null;
  /** How many checks the figures above are based on. */
  sampleCount: number;
  /** When the service was last checked at all. */
  lastCheckedAt: Date | null;
};

/** Health for every service, keyed by service id. */
export type ServiceHealthMap = Map<string, ServiceHealth>;

type HealthRow = {
  serviceId: string;
  total: number;
  successes: number;
  p50: number | null;
  p95: number | null;
  lastLatencyMs: number | null;
  lastCheckedAt: Date | null;
};

const PERCENTAGE_DECIMALS = 3;

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Aggregates probe results over the configured trailing window.
 *
 * One query for every service rather than one per service: the N+1 version is
 * invisible with six services and pathological with six hundred.
 */
export async function getServiceHealth(
  windowHours = env.UPTIME_WINDOW_HOURS,
): Promise<ServiceHealthMap> {
  const since = new Date(Date.now() - windowHours * MS_PER_HOUR);

  const rows = await prisma.$queryRaw<HealthRow[]>`
    WITH windowed AS (
      SELECT "serviceId", "ok", "latencyMs", "checkedAt"
      FROM "ProbeResult"
      WHERE "checkedAt" >= ${since}
    ),
    aggregates AS (
      SELECT
        "serviceId",
        COUNT(*)::int                                     AS total,
        COUNT(*) FILTER (WHERE "ok")::int                 AS successes,
        percentile_cont(0.5) WITHIN GROUP (
          ORDER BY "latencyMs"
        ) FILTER (WHERE "ok" AND "latencyMs" IS NOT NULL)  AS p50,
        percentile_cont(0.95) WITHIN GROUP (
          ORDER BY "latencyMs"
        ) FILTER (WHERE "ok" AND "latencyMs" IS NOT NULL)  AS p95,
        MAX("checkedAt")                                   AS "lastCheckedAt"
      FROM windowed
      GROUP BY "serviceId"
    ),
    latest AS (
      -- DISTINCT ON is PostgreSQL's cheapest "latest row per group": the index
      -- already orders by (serviceId, checkedAt DESC), so this is a skip scan
      -- rather than a sort.
      SELECT DISTINCT ON ("serviceId") "serviceId", "latencyMs"
      FROM windowed
      WHERE "ok" AND "latencyMs" IS NOT NULL
      ORDER BY "serviceId", "checkedAt" DESC
    )
    SELECT
      a."serviceId",
      a.total,
      a.successes,
      a.p50,
      a.p95,
      a."lastCheckedAt",
      l."latencyMs" AS "lastLatencyMs"
    FROM aggregates a
    LEFT JOIN latest l ON l."serviceId" = a."serviceId"
  `;

  const health: ServiceHealthMap = new Map();

  for (const row of rows) {
    health.set(row.serviceId, {
      // No observations means no uptime figure. Reporting 100% for a service
      // that has never been checked is exactly the lie this system exists to
      // avoid.
      uptimePercent:
        row.total > 0 ? round((row.successes / row.total) * 100, PERCENTAGE_DECIMALS) : null,
      latencyP50Ms: row.p50 === null ? null : Math.round(row.p50),
      latencyP95Ms: row.p95 === null ? null : Math.round(row.p95),
      lastLatencyMs: row.lastLatencyMs,
      sampleCount: row.total,
      lastCheckedAt: row.lastCheckedAt,
    });
  }

  return health;
}

/** Health for a service with no stored observations at all. */
export const NO_OBSERVATIONS: ServiceHealth = {
  uptimePercent: null,
  latencyP50Ms: null,
  latencyP95Ms: null,
  lastLatencyMs: null,
  sampleCount: 0,
  lastCheckedAt: null,
};

export type MetricBucket = {
  bucket: Date;
  type: string;
  value: number;
};

/**
 * Reads a downsampled metric series.
 *
 * A client asking for 24 hours at a 5-second sampling interval would otherwise
 * receive ~17,000 points per family — far more than a chart can render and far
 * more than a browser should parse. `date_bin` groups the range into at most
 * `maxPoints` even buckets and averages within each, so the response size is
 * bounded by the request rather than by the range.
 *
 * Averaging is the right reducer for the utilisation percentages and byte rates
 * collected here. A max-reducer would be preferable for spike detection, which
 * is why the bucket width is returned to the caller rather than assumed.
 */
export async function getMetricSeries(options: {
  host: string;
  types: string[];
  from: Date;
  to: Date;
  maxPoints: number;
}): Promise<{ buckets: MetricBucket[]; bucketSeconds: number }> {
  const { host, types, from, to, maxPoints } = options;

  const spanMs = Math.max(1, to.getTime() - from.getTime());
  const bucketSeconds = Math.max(1, Math.ceil(spanMs / maxPoints / 1000));

  const buckets = await prisma.$queryRaw<MetricBucket[]>`
    SELECT
      -- Bucket origin is the range start, so the first bucket aligns with the
      -- request rather than with an arbitrary epoch.
      date_bin(make_interval(secs => ${bucketSeconds}), "recordedAt", ${from}) AS bucket,
      "type",
      AVG("value")::double precision AS value
    FROM "Metric"
    WHERE "host" = ${host}
      AND "type" IN (${Prisma.join(types)})
      AND "recordedAt" >= ${from}
      AND "recordedAt" <= ${to}
    GROUP BY bucket, "type"
    ORDER BY bucket ASC
  `;

  return { buckets, bucketSeconds };
}
