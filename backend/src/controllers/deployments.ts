import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
export const getDeployments = async (req: Request, res: Response) => {
  try {
    const deployments = await prisma.deployment.findMany({
      take: 20,
      orderBy: { createdAt: 'desc' },
      include: {
        stages: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    res.status(200).json({
      success: true,
      data: deployments,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
};
