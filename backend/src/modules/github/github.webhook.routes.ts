import { Router } from 'express';
import { handleWebhook } from './github.webhook';

/**
 * Mounted separately from the rest of the GitHub routes because it needs the
 * raw request body for signature verification, and is authenticated by that
 * signature rather than by a bearer token.
 */
const router = Router();

router.post('/', handleWebhook);

export default router;
