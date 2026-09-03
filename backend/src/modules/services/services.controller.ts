import { AuditAction, ServiceState } from '@prisma/client';
import type { Request, Response } from 'express';
import { env } from '../../config/env';
import { prisma } from '../../db/prisma';
import { recordAudit } from '../../lib/audit';
import { CacheNamespace, cacheKey, cached, invalidate } from '../../lib/cache';
import { NotFoundError } from '../../lib/errors';
import { sendSuccess } from '../../lib/http';
import { parseBody, parseParams, uuidParamSchema } from '../../lib/validation';
import { requireUser } from '../../middleware/auth';
import { NO_OBSERVATIONS, getServiceHealth } from '../telemetry/telemetry.service';
import { createServiceSchema, updateServiceSchema } from './services.schemas';

/**
 * Service catalogue reads.
 *
 * Health figures are joined in from observations rather than read off the
 * `Service` row. `uptime` and `responseTime` used to be stored columns whose
 * only writer was the seed script, so every service reported the number a
 * literal in seed.ts had assigned it — "Payment Processor" was permanently
 * 99.95% at 150ms because that is what was typed there.
 *
 * A service with no stored probe results reports nulls, and the client renders
 * that as "not measured" rather than inventing a figure.
 */
export async function listServices(_req: Request, res: Response): Promise<void> {
  /**
   * Cached because the health figures are not a column read: they come from a
   * window function over every stored probe result, and every open dashboard
   * asks for them every thirty seconds. The same answer is served to every
   * authenticated caller, which is what makes one shared key safe here.
   *
   * A status change invalidates this immediately, so the TTL only ever bounds
   * staleness in the windowed aggregates — never in whether a service is up.
   */
  const enriched = await cached(cacheKey(CacheNamespace.Services, 'list'), async () => {
    const [services, health] = await Promise.all([
      prisma.service.findMany({
        orderBy: { name: 'asc' },
        select: {
          id: true,
          name: true,
          description: true,
          status: true,
          probeType: true,
          probeTarget: true,
          probeIntervalSeconds: true,
          isMonitored: true,
          lastCheckedAt: true,
          updatedAt: true,
        },
      }),
      getServiceHealth(),
    ]);

    return services.map((service) => ({
      ...service,
      ...(health.get(service.id) ?? NO_OBSERVATIONS),
    }));
  });

  sendSuccess(res, enriched, {
    /** States the window the uptime and latency figures describe. */
    uptimeWindowHours: env.UPTIME_WINDOW_HOURS,
    probesEnabled: env.PROBES_ENABLED,
  });
}

/** How many recent checks the detail view returns. */
const RECENT_PROBE_LIMIT = 50;

/**
 * A single service with its recent raw observations.
 *
 * The results are the evidence behind the summary figures, so an operator can
 * see *why* a service is marked degraded rather than being asked to trust a
 * percentage.
 */
export async function getService(req: Request, res: Response): Promise<void> {
  const { id } = parseParams(req, uuidParamSchema);

  const [service, health, recentChecks] = await Promise.all([
    prisma.service.findUnique({ where: { id } }),
    getServiceHealth(),
    prisma.probeResult.findMany({
      where: { serviceId: id },
      orderBy: { checkedAt: 'desc' },
      take: RECENT_PROBE_LIMIT,
      select: { ok: true, latencyMs: true, statusCode: true, error: true, checkedAt: true },
    }),
  ]);

  if (!service) throw new NotFoundError('Service');

  sendSuccess(
    res,
    { ...service, ...(health.get(service.id) ?? NO_OBSERVATIONS), recentChecks },
    { uptimeWindowHours: env.UPTIME_WINDOW_HOURS },
  );
}

export async function createService(req: Request, res: Response): Promise<void> {
  const actor = requireUser(req);
  const input = parseBody(req, createServiceSchema);

  const service = await prisma.service.create({
    data: {
      ...input,
      /**
       * A brand-new service starts DEGRADED, not ONLINE.
       *
       * It has not been checked yet, and claiming health that has not been
       * observed is the exact failure this system is built to avoid. The first
       * successful sweep promotes it.
       */
      status: ServiceState.DEGRADED,
    },
  });

  // The catalogue has changed shape, so the cached list is wrong now rather
  // than in ten seconds.
  await invalidate(CacheNamespace.Services);

  recordAudit(req, actor.id, {
    action: AuditAction.SERVICE_CREATED,
    resource: 'service',
    resourceId: service.id,
    metadata: {
      name: service.name,
      probeType: service.probeType,
      probeTarget: service.probeTarget,
    },
  });

  sendSuccess(res, service, undefined, 201);
}

export async function updateService(req: Request, res: Response): Promise<void> {
  const actor = requireUser(req);
  const { id } = parseParams(req, uuidParamSchema);
  const input = parseBody(req, updateServiceSchema);

  const existing = await prisma.service.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Service');

  const service = await prisma.service.update({
    where: { id },
    data: {
      ...input,
      /**
       * Leaving or entering maintenance resets the hysteresis counters. Stale
       * counts from before a planned window would otherwise let a single
       * post-window failure trip the threshold immediately.
       */
      ...(input.status && input.status !== existing.status
        ? { consecutiveFailures: 0, consecutiveSuccesses: 0 }
        : {}),
    },
  });

  await invalidate(CacheNamespace.Services);

  recordAudit(req, actor.id, {
    action: AuditAction.SERVICE_UPDATED,
    resource: 'service',
    resourceId: id,
    metadata: { fields: Object.keys(input) },
  });

  sendSuccess(res, service);
}

export async function deleteService(req: Request, res: Response): Promise<void> {
  const actor = requireUser(req);
  const { id } = parseParams(req, uuidParamSchema);

  const existing = await prisma.service.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Service');

  // Probe history cascades with the service; incidents keep their record and
  // have their service reference set to null.
  await prisma.service.delete({ where: { id } });

  await invalidate(CacheNamespace.Services);

  recordAudit(req, actor.id, {
    action: AuditAction.SERVICE_DELETED,
    resource: 'service',
    resourceId: id,
    metadata: { name: existing.name },
  });

  sendSuccess(res, { id, deleted: true });
}
