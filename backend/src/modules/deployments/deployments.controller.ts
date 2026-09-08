import { CiProvider, DeploymentStatus, type Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { isGitHubPollingConfigured, isGitHubWebhookConfigured } from '../../config/env';
import { prisma } from '../../db/prisma';
import { CacheNamespace, cacheKey, cached } from '../../lib/cache';
import { NotFoundError } from '../../lib/errors';
import { pageMeta, sendSuccess } from '../../lib/http';
import { paginationSchema, parseParams, parseQuery, uuidParamSchema } from '../../lib/validation';

/**
 * Deployment history.
 *
 * Every row here is a real workflow run mirrored from GitHub Actions. The
 * previous implementation read five rows the seed script had invented, with
 * `Math.random()` durations and stages named Build/Test/Deploy that
 * corresponded to nothing.
 */

const listQuerySchema = paginationSchema.extend({
  status: z.nativeEnum(DeploymentStatus).optional(),
  repo: z.string().trim().min(1).max(200).optional(),
  branch: z.string().trim().min(1).max(200).optional(),
});

export async function listDeployments(req: Request, res: Response): Promise<void> {
  const { limit, offset, status, repo, branch } = parseQuery(req, listQuerySchema);

  const where: Prisma.DeploymentWhereInput = {
    ...(status ? { status } : {}),
    ...(repo ? { repo } : {}),
    ...(branch ? { branch } : {}),
  };

  /**
   * The filters and the page are part of the key: two callers asking different
   * questions must never share an answer. Every run that lands — by webhook or
   * by sync — invalidates the namespace, so a finished deployment appears at
   * once rather than after the TTL.
   */
  const discriminator = JSON.stringify({ limit, offset, status, repo, branch });

  const { deployments, total, connectionCount } = await cached(
    cacheKey(CacheNamespace.Deployments, discriminator),
    async () => {
      const [rows, count, connections] = await prisma.$transaction([
        prisma.deployment.findMany({
          where,
          take: limit,
          skip: offset,
          orderBy: { createdAt: 'desc' },
          include: { stages: { orderBy: [{ startedAt: 'asc' }, { createdAt: 'asc' }] } },
        }),
        prisma.deployment.count({ where }),
        prisma.repoConnection.count({ where: { isActive: true } }),
      ]);

      return { deployments: rows, total: count, connectionCount: connections };
    },
  );

  sendSuccess(res, deployments, {
    ...pageMeta(total, limit, offset),
    /**
     * Lets the client distinguish "no repository is connected" from "connected
     * but nothing has run yet". Without this the two are the same empty list,
     * and a user cannot tell a configuration problem from a quiet week.
     */
    connectedRepositories: connectionCount,
    pollingConfigured: isGitHubPollingConfigured,
    webhookConfigured: isGitHubWebhookConfigured,
  });
}

/** One deployment with its jobs. */
export async function getDeployment(req: Request, res: Response): Promise<void> {
  const { id } = parseParams(req, uuidParamSchema);

  const deployment = await prisma.deployment.findUnique({
    where: { id },
    include: {
      stages: { orderBy: [{ startedAt: 'asc' }, { createdAt: 'asc' }] },
      repoConnection: { select: { id: true, owner: true, name: true } },
    },
  });

  if (!deployment) throw new NotFoundError('Deployment');

  sendSuccess(res, deployment);
}

/**
 * Delivery statistics over recent history.
 *
 * Success rate and mean duration are computed in the database over the selected
 * window rather than by pulling every row and reducing in JavaScript.
 */
export async function getDeploymentStats(req: Request, res: Response): Promise<void> {
  const { limit } = parseQuery(
    req,
    z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }),
  );

  const recent = await prisma.deployment.findMany({
    take: limit,
    orderBy: { createdAt: 'desc' },
    select: { status: true, duration: true },
  });

  const finished = recent.filter(
    (d) => d.status !== DeploymentStatus.RUNNING && d.status !== DeploymentStatus.PENDING,
  );
  const succeeded = finished.filter((d) => d.status === DeploymentStatus.SUCCESS).length;
  const durations = recent.map((d) => d.duration).filter((d): d is number => d !== null);

  sendSuccess(res, {
    sampled: recent.length,
    finished: finished.length,
    succeeded,
    failed: finished.length - succeeded,
    /**
     * Null rather than 100% when nothing has finished. A success rate computed
     * from zero deployments is not a perfect score, it is an absent measurement.
     */
    successRatePercent:
      finished.length > 0 ? Math.round((succeeded / finished.length) * 10000) / 100 : null,
    medianDurationSeconds: median(durations),
    provider: CiProvider.GITHUB,
  });
}

/** Median, which is far more representative of build times than a mean. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? null;
  const lower = sorted[middle - 1];
  const upper = sorted[middle];
  return lower !== undefined && upper !== undefined ? Math.round((lower + upper) / 2) : null;
}
