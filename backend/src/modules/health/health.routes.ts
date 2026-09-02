import { Router } from 'express';
import { prisma } from '../../db/prisma';
import { sendSuccess } from '../../lib/http';

/**
 * Liveness and readiness endpoints.
 *
 * These are distinct on purpose. An orchestrator restarts a container that
 * fails liveness, but only removes it from the load balancer when it fails
 * readiness. Reporting a transient database outage as a liveness failure would
 * cause every replica to be killed and restarted during a failover, which turns
 * a recoverable blip into an outage.
 */

const router = Router();

/** Liveness: the event loop is running. Deliberately touches no dependency. */
router.get('/', (_req, res) => {
  sendSuccess(res, {
    status: 'ok',
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

/** Readiness: every dependency required to serve traffic is reachable. */
router.get('/ready', async (_req, res) => {
  const startedAt = process.hrtime.bigint();
  let databaseReachable = true;

  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    databaseReachable = false;
  }

  const NANOSECONDS_PER_MILLISECOND = 1_000_000;
  const latencyMs = Number(process.hrtime.bigint() - startedAt) / NANOSECONDS_PER_MILLISECOND;

  const body = {
    status: databaseReachable ? ('ready' as const) : ('degraded' as const),
    checks: {
      database: {
        reachable: databaseReachable,
        latencyMs: Math.round(latencyMs * 100) / 100,
      },
    },
    timestamp: new Date().toISOString(),
  };

  res.status(databaseReachable ? 200 : 503).json({ success: databaseReachable, data: body });
});

export default router;
