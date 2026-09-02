import type { Request, Response } from 'express';
import { prisma } from '../../db/prisma';
import { pageMeta, sendSuccess } from '../../lib/http';
import { paginationSchema, parseQuery } from '../../lib/validation';

/**
 * Deployment history reads.
 *
 * The previous implementation hard-coded `take: 20` with no way to page past
 * it, so any history older than the twentieth run was unreachable through the
 * API. Pagination is now an explicit, validated part of the contract and the
 * total is returned alongside the page so a client can render a real pager.
 */
export async function listDeployments(req: Request, res: Response): Promise<void> {
  const { limit, offset } = parseQuery(req, paginationSchema);

  const [deployments, total] = await prisma.$transaction([
    prisma.deployment.findMany({
      take: limit,
      skip: offset,
      orderBy: { createdAt: 'desc' },
      include: {
        stages: { orderBy: { createdAt: 'asc' } },
      },
    }),
    prisma.deployment.count(),
  ]);

  sendSuccess(res, deployments, pageMeta(total, limit, offset));
}
