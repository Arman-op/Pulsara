import { Router } from 'express';
import { getDeployments } from '../controllers/deployments';
import { protect } from '../middleware/auth';
const router = Router();
router.get('/', protect, getDeployments);
export default router;
