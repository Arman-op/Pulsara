import { Router } from 'express';
import { protect } from '../../middleware/auth';
import { listIncidents } from './incidents.controller';

const router = Router();

router.get('/', protect, listIncidents);

export default router;
