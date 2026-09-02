import type { CookieOptions, Request, Response } from 'express';
import { REFRESH_TOKEN_COOKIE } from '../../config/constants';
import { isProduction } from '../../config/env';
import { UnauthenticatedError } from '../../lib/errors';
import { sendSuccess } from '../../lib/http';
import { parseBody } from '../../lib/validation';
import { requireUser } from '../../middleware/auth';
import { firebaseLoginSchema, loginSchema } from './auth.schemas';
import {
  getCurrentUser,
  loginWithFirebase,
  loginWithPassword,
  revokeSession,
  rotateSession,
  type IssuedSession,
  type SessionContext,
} from './auth.service';

/**
 * HTTP surface for authentication.
 *
 * The access token is returned in the response body for the client to hold in
 * memory; the refresh token is set as an HttpOnly cookie and never reaches
 * JavaScript. This split is deliberate. A token readable by script is a token
 * an XSS payload can exfiltrate, and the refresh token is the long-lived,
 * high-value half of the pair.
 */

function refreshCookieOptions(expiresAt: Date): CookieOptions {
  return {
    httpOnly: true,
    // Requires HTTPS. In development the API is served over plain HTTP on
    // localhost, where a Secure cookie would simply be dropped.
    secure: isProduction,
    /**
     * The production topology serves the SPA from a different registrable
     * domain than the API, which makes the refresh call cross-site; only
     * SameSite=None is sent in that context, and it is only accepted alongside
     * Secure. Locally both run on localhost, where Lax is both sufficient and
     * strictly safer.
     */
    sameSite: isProduction ? 'none' : 'lax',
    expires: expiresAt,
    path: '/api/auth',
  };
}

function sessionContext(req: Request): SessionContext {
  return {
    userAgent: req.headers['user-agent'],
    ipAddress: req.ip,
  };
}

function respondWithSession(res: Response, session: IssuedSession): void {
  res.cookie(
    REFRESH_TOKEN_COOKIE,
    session.refreshToken,
    refreshCookieOptions(session.refreshTokenExpiresAt),
  );

  sendSuccess(res, {
    user: session.user,
    accessToken: session.accessToken,
  });
}

export async function login(req: Request, res: Response): Promise<void> {
  const { email, password } = parseBody(req, loginSchema);
  respondWithSession(res, await loginWithPassword(email, password, sessionContext(req)));
}

export async function firebaseLogin(req: Request, res: Response): Promise<void> {
  const { idToken } = parseBody(req, firebaseLoginSchema);
  respondWithSession(res, await loginWithFirebase(idToken, sessionContext(req)));
}

export async function refresh(req: Request, res: Response): Promise<void> {
  const token: unknown = req.cookies?.[REFRESH_TOKEN_COOKIE];

  if (typeof token !== 'string' || token.length === 0) {
    throw new UnauthenticatedError('No refresh token was presented');
  }

  respondWithSession(res, await rotateSession(token, sessionContext(req)));
}

export async function logout(req: Request, res: Response): Promise<void> {
  const token: unknown = req.cookies?.[REFRESH_TOKEN_COOKIE];
  await revokeSession(typeof token === 'string' ? token : undefined);

  // Cleared with the same attributes it was set with; a browser ignores a
  // clear whose path or SameSite differs from the original cookie.
  res.clearCookie(REFRESH_TOKEN_COOKIE, refreshCookieOptions(new Date(0)));
  sendSuccess(res, { revoked: true });
}

export async function me(req: Request, res: Response): Promise<void> {
  const { id } = requireUser(req);
  sendSuccess(res, await getCurrentUser(id));
}
