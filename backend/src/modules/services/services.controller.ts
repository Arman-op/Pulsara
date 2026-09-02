import type { Request, Response } from 'express';
import { prisma } from '../../db/prisma';
import { sendSuccess } from '../../lib/http';

/**
 * Service catalogue reads.
 *
 * There is no try/catch here by design: Express 5 forwards a rejected handler
 * promise to the error middleware automatically, so hand-written catch blocks
 * would only duplicate — and previously, weaken — the central error contract.
 */
export async function listServices(_req: Request, res: Response): Promise<void> {
  const services = await prisma.service.findMany({
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      description: true,
      status: true,
      uptime: true,
      responseTime: true,
      updatedAt: true,
    },
  });

  sendSuccess(res, services);
}
