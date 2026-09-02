import type { Request, Response } from 'express';
import { prisma } from '../../db/prisma';
import { pageMeta, sendSuccess } from '../../lib/http';
import { paginationSchema, parseQuery } from '../../lib/validation';

/**
 * Incident feed reads.
 *
 * The assignee is projected down to the fields the UI renders. Selecting the
 * whole `User` row here would have put `passwordHash` one careless `include`
 * away from the wire.
 */
export async function listIncidents(req: Request, res: Response): Promise<void> {
  const { limit, offset } = parseQuery(req, paginationSchema);

  const [incidents, total] = await prisma.$transaction([
    prisma.incident.findMany({
      take: limit,
      skip: offset,
      orderBy: { createdAt: 'desc' },
      include: {
        service: { select: { id: true, name: true, status: true } },
        assignee: { select: { id: true, name: true, email: true, avatarUrl: true } },
      },
    }),
    prisma.incident.count(),
  ]);

  sendSuccess(res, incidents, pageMeta(total, limit, offset));
}
