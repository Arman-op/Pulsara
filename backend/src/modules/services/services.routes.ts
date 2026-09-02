import { Router } from 'express';
import { protect } from '../../middleware/auth';
import { listServices } from './services.controller';

const router = Router();

router.get('/', protect, listServices);

export default router;
