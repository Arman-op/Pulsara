import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { env } from '../../config/env';
import { protect } from '../../middleware/auth';
import {
  changePassword,
  listSessions,
  revokeAllSessions,
  updateProfile,
} from './account.controller';
import { firebaseLogin, login, logout, me, refresh } from './auth.controller';

const router = Router();

/**
 * Credential endpoints get a far tighter budget than the rest of the API.
 *
 * The global limiter is sized for a dashboard polling several resources per
 * page load, which is orders of magnitude more generous than any legitimate
 * sign-in pattern. Without a dedicated limit, that headroom is a free
 * password-spraying budget.
 *
 * Only failed attempts are counted, so a user working normally in several tabs
 * is never locked out by their own successful logins.
 */
const credentialLimiter = rateLimit({
  windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
  limit: env.AUTH_RATE_LIMIT_MAX_ATTEMPTS,
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many sign-in attempts; please wait before trying again',
    },
  },
});

router.post('/login', credentialLimiter, login);
router.post('/firebase', credentialLimiter, firebaseLogin);
router.post('/refresh', refresh);
router.post('/logout', logout);
router.get('/me', protect, me);
router.patch('/me', protect, updateProfile);

/**
 * Changing a password is a credential operation, so it shares the tight
 * per-IP budget rather than the general API allowance: it is a place an
 * attacker with a stolen access token would try to brute-force the existing
 * password.
 */
router.post('/password', protect, credentialLimiter, changePassword);

router.get('/sessions', protect, listSessions);
router.delete('/sessions', protect, revokeAllSessions);

export default router;
