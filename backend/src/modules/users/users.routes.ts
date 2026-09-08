import { Router } from 'express';
import { protect } from '../../middleware/auth';
import { requireAdmin } from '../../middleware/authorize';
import { listAuditLog, listUsers, updateUser } from './users.controller';

const router = Router();

/**
 * Entirely administrator-only. The user list exposes email addresses and
 * sign-in times, and the audit trail records who did what, both of which are
 * sensitive in their own right.
 */
router.get('/', protect, requireAdmin, listUsers);
router.patch('/:id', protect, requireAdmin, updateUser);
router.get('/audit/log', protect, requireAdmin, listAuditLog);

export default router;
