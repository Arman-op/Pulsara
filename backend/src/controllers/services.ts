import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
export const getServices = async (req: Request, res: Response) => {
    try {
        const services = await prisma.service.findMany({
            orderBy: { name: 'asc' },
        });
        res.status(200).json({
            success: true,
            data: services,
        });
    } catch (err: any) {
        res.status(500).json({ success: false, error: err.message });
    }
};