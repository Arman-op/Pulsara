import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
export const getIncidents = async (req: Request, res: Response) => {
  try {
    const incidents = await prisma.incident.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        service: true,
        assignee: {
          select: { id: true, name: true, email: true, avatarUrl: true },
        },
      },
    });
    res.status(200).json({
      success: true,
      data: incidents,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
};