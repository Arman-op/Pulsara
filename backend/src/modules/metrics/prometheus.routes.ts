import { Router } from 'express';
import { scrape } from './prometheus.controller';

const router = Router();

/**
 * `GET /metrics`. Mounted at the root rather than under the API prefix, because
 * that is the path every Prometheus installation is already configured to try.
 */
router.get('/', scrape);

export default router;
