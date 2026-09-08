import { Router } from 'express';
import { protect } from '../../middleware/auth';
import { requireAdmin } from '../../middleware/authorize';
import {
  createService,
  deleteService,
  getService,
  listServices,
  updateService,
} from './services.controller';

const router = Router();

/**
 * Reads are open to any authenticated user; changes to the catalogue are
 * administrator-only. Registering a probe target makes this server issue
 * outbound requests to an address of the caller's choosing, which is not a
 * capability a read-only viewer should have.
 */
router.get('/', protect, listServices);
router.get('/:id', protect, getService);
router.post('/', protect, requireAdmin, createService);
router.patch('/:id', protect, requireAdmin, updateService);
router.delete('/:id', protect, requireAdmin, deleteService);

export default router;
