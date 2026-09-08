import { Router } from 'express';
import { protect } from '../../middleware/auth';
import { requireMember } from '../../middleware/authorize';
import {
  addComment,
  createIncident,
  getIncident,
  getIncidentSummary,
  listIncidents,
  updateIncident,
} from './incidents.controller';

const router = Router();

/**
 * Reads are open to any authenticated user; anything that changes an incident
 * requires at least MEMBER. A VIEWER can watch an outage unfold but cannot
 * silently resolve it.
 */
router.get('/', protect, listIncidents);
router.get('/summary', protect, getIncidentSummary);
router.get('/:id', protect, getIncident);
router.post('/', protect, requireMember, createIncident);
router.patch('/:id', protect, requireMember, updateIncident);
router.post('/:id/comments', protect, requireMember, addComment);

export default router;
