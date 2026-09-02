import { Router } from 'express';
import { protect } from '../../middleware/auth';
import { getLatest, getSeries, listHosts } from './telemetry.controller';

const router = Router();

router.get('/series', protect, getSeries);
router.get('/latest', protect, getLatest);
router.get('/hosts', protect, listHosts);

export default router;
