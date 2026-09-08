import { Router } from 'express';
import { protect } from '../../middleware/auth';
import { getDeployment, getDeploymentStats, listDeployments } from './deployments.controller';

const router = Router();

router.get('/', protect, listDeployments);
router.get('/stats', protect, getDeploymentStats);
router.get('/:id', protect, getDeployment);

export default router;
