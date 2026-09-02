import type { Request, Response } from 'express';
import { z } from 'zod';
import { MS_PER_HOUR } from '../../config/constants';
import { env } from '../../config/env';
import { prisma } from '../../db/prisma';
import { sendSuccess } from '../../lib/http';
import { parseQuery } from '../../lib/validation';
import { MetricType } from './host-collector';
import { getMetricSeries } from './telemetry.service';

/**
 * Telemetry read API.
 *
 * Serves the stored host time series. The chart on the dashboard used to hold
 * fifteen points that existed only in the browser's memory, produced by a
 * random generator, and vanished on reload. It now reads real recorded samples
 * over a requested range.
 */

const KNOWN_METRIC_TYPES = Object.values(MetricType);

/** Bounds on what a single request may ask for. */
const MAX_RANGE_HOURS = 24 * 30;
const DEFAULT_RANGE_HOURS = 1;
const MIN_POINTS = 10;
const MAX_POINTS = 2_000;
const DEFAULT_POINTS = 240;

const seriesQuerySchema = z
  .object({
    /** ISO-8601 timestamps. Defaults to the last hour. */
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    /** Comma-separated metric families; defaults to all of them. */
    types: z
      .string()
      .optional()
      .transform((value) =>
        value
          ? value
              .split(',')
              .map((item) => item.trim())
              .filter(Boolean)
          : [...KNOWN_METRIC_TYPES],
      )
      .pipe(
        z
          .array(z.enum(KNOWN_METRIC_TYPES as [string, ...string[]]))
          .min(1, 'at least one metric type is required'),
      ),
    /**
     * Upper bound on returned points per family. The server buckets to fit,
     * so a client controls its own payload size rather than discovering the
     * range it asked for was too large.
     */
    maxPoints: z.coerce.number().int().min(MIN_POINTS).max(MAX_POINTS).default(DEFAULT_POINTS),
    host: z.string().min(1).default(env.TELEMETRY_HOST_ID),
  })
  .transform((value) => {
    const to = value.to ?? new Date();
    const from = value.from ?? new Date(to.getTime() - DEFAULT_RANGE_HOURS * MS_PER_HOUR);
    return { ...value, from, to };
  })
  .refine((value) => value.from < value.to, {
    path: ['from'],
    message: 'must be earlier than "to"',
  })
  .refine((value) => value.to.getTime() - value.from.getTime() <= MAX_RANGE_HOURS * MS_PER_HOUR, {
    path: ['from'],
    message: `range must not exceed ${MAX_RANGE_HOURS} hours`,
  });

/**
 * Returns a downsampled series, reshaped into one object per bucket.
 *
 * The database returns one row per (bucket, type) because that is the natural
 * grouping; charts want one record per timestamp with a field per series. The
 * pivot happens here rather than in the browser so the client stays a renderer.
 */
export async function getSeries(req: Request, res: Response): Promise<void> {
  const { from, to, types, maxPoints, host } = parseQuery(req, seriesQuerySchema);

  const { buckets, bucketSeconds } = await getMetricSeries({ host, types, from, to, maxPoints });

  const byTimestamp = new Map<number, Record<string, number | string>>();

  for (const row of buckets) {
    const key = row.bucket.getTime();
    let point = byTimestamp.get(key);
    if (!point) {
      point = { timestamp: row.bucket.toISOString() };
      byTimestamp.set(key, point);
    }
    point[row.type] = row.value;
  }

  const points = [...byTimestamp.entries()].sort(([a], [b]) => a - b).map(([, point]) => point);

  sendSuccess(res, points, {
    host,
    from: from.toISOString(),
    to: to.toISOString(),
    /** Bucket width, so a client can label the axis honestly. */
    bucketSeconds,
    types,
    /**
     * Distinguishes "the host reported nothing in this range" from "the range
     * is fine but the collector is not running", which look identical if all a
     * client receives is an empty array.
     */
    collectorEnabled: env.METRICS_COLLECTION_ENABLED,
  });
}

/**
 * Most recent sample of each metric family.
 *
 * Read from storage rather than from the collector's in-memory snapshot, so the
 * answer is the same regardless of which replica serves the request.
 */
export async function getLatest(req: Request, res: Response): Promise<void> {
  const { host } = parseQuery(
    req,
    z.object({ host: z.string().min(1).default(env.TELEMETRY_HOST_ID) }),
  );

  const rows = await prisma.$queryRaw<
    { type: string; value: number; unit: string; recordedAt: Date }[]
  >`
    SELECT DISTINCT ON ("type") "type", "value", "unit", "recordedAt"
    FROM "Metric"
    WHERE "host" = ${host}
    ORDER BY "type", "recordedAt" DESC
  `;

  sendSuccess(res, rows, { host, collectorEnabled: env.METRICS_COLLECTION_ENABLED });
}

/** Hosts that have reported at least one sample. */
export async function listHosts(_req: Request, res: Response): Promise<void> {
  const rows = await prisma.metric.groupBy({
    by: ['host'],
    _max: { recordedAt: true },
    orderBy: { host: 'asc' },
  });

  sendSuccess(
    res,
    rows.map((row) => ({ host: row.host, lastSeenAt: row._max.recordedAt })),
  );
}
