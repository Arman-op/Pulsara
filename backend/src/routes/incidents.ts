import { Router } from 'express';
import { getIncidents } from '../controllers/incidents';
import { protect } from '../middleware/auth';
const router = Router();
router.get('/', protect, getIncidents);
export default router;
