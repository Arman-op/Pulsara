import { Router } from 'express';
import { getServices } from '../controllers/services';
import { protect } from '../middleware/auth';
const router = Router();
router.get('/', protect, getServices);
export default router;
