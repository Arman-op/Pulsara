import type { NextFunction, Request, Response } from 'express';
import { UnauthenticatedError } from '../lib/errors';
import { accessTokenClaimsSchema, claimsToUser } from '../modules/auth/auth.types';
import { isIssuedAfterRevocation, loadPrincipal } from '../modules/auth/principal';
import { verifyAccessToken } from '../modules/auth/tokens';

const BEARER_PREFIX = 'Bearer ';

/**
 * Rejects a request that does not carry a valid, unexpired, still-honoured
 * access token.
 *
 * Verification is in three parts, and the third is the one that matters most.
 *
 * The signature proves the token was issued by this service. The claim schema
 * is then applied to the payload, because a token is signed data but its
 * *shape* is still untrusted input — one minted by an older deployment can be
 * validly signed and yet omit a field the current code expects.
 *
 * Finally the account behind it is read. A token is a snapshot of who somebody
 * was when it was issued, and between issuing and expiry they can be demoted,
 * deactivated, or have every session deliberately revoked. Trusting the claims
 * meant "sign out everywhere" left a stolen token working for the rest of its
 * lifetime — the exact window the person clicking it is trying to close — and
 * meant a demoted administrator kept administrative power until it expired.
 *
 * The cost is one primary-key lookup, served from Redis where it is configured.
 * It is paid on every authenticated request rather than only on privileged
 * routes, because "which routes are strict" is not a distinction anybody should
 * have to hold in their head.
 */
export async function protect(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;

  if (!header?.startsWith(BEARER_PREFIX)) {
    next(new UnauthenticatedError('Missing bearer token'));
    return;
  }

  const token = header.slice(BEARER_PREFIX.length).trim();
  const payload = verifyAccessToken(token);

  if (!payload) {
    next(new UnauthenticatedError('Access token is invalid or has expired'));
    return;
  }

  const claims = accessTokenClaimsSchema.safeParse(payload);
  if (!claims.success) {
    next(new UnauthenticatedError('Access token claims are malformed'));
    return;
  }

  const principal = await loadPrincipal(claims.data.sub);

  if (!principal) {
    next(new UnauthenticatedError('Account no longer exists'));
    return;
  }

  if (!principal.isActive) {
    next(new UnauthenticatedError('Account is no longer active'));
    return;
  }

  const issuedAt = { seconds: payload.iat, milliseconds: claims.data.iatMs };

  if (!isIssuedAfterRevocation(issuedAt, principal.sessionsValidFrom)) {
    next(new UnauthenticatedError('Session has been revoked; please sign in again'));
    return;
  }

  /**
   * The role comes from the database, not from the token, so a handler reading
   * `req.user.role` sees the same answer an authorisation guard would.
   */
  req.user = { ...claimsToUser(claims.data), role: principal.role };
  next();
}

/**
 * Reads the authenticated principal, asserting that `protect` ran first.
 *
 * Handlers call this instead of dereferencing the optional `req.user`, so a
 * route accidentally mounted without the guard fails loudly during development
 * rather than silently serving data for `undefined`.
 */
export function requireUser(req: Request): NonNullable<Request['user']> {
  if (!req.user) {
    throw new UnauthenticatedError('Route requires authentication middleware');
  }
  return req.user;
}
