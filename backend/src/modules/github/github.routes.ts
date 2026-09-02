import { Router } from 'express';
import { protect } from '../../middleware/auth';
import { requireAdmin } from '../../middleware/authorize';
import {
  addConnection,
  getIntegrationStatus,
  listConnections,
  removeConnection,
  syncNow,
} from './github.controller';

const router = Router();

/**
 * Connecting a repository grants this server read access to somebody's CI
 * history and consumes a shared rate-limit budget, so it is administrator-only.
 */
router.get('/status', protect, getIntegrationStatus);
router.get('/connections', protect, listConnections);
router.post('/connections', protect, requireAdmin, addConnection);
router.delete('/connections/:id', protect, requireAdmin, removeConnection);
router.post('/connections/:id/sync', protect, requireAdmin, syncNow);

export default router;
