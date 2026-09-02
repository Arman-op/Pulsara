import { Router } from 'express';
import { protect } from '../../middleware/auth';
import { listDeployments } from './deployments.controller';

const router = Router();

router.get('/', protect, listDeployments);

export default router;
