import type { NextFunction, Request, Response } from 'express';
import { UnauthenticatedError } from '../lib/errors';
import { accessTokenClaimsSchema, claimsToUser } from '../modules/auth/auth.types';
import { verifyAccessToken } from '../modules/auth/tokens';

const BEARER_PREFIX = 'Bearer ';

/**
 * Rejects a request that does not carry a valid, unexpired access token.
 *
 * Claims are validated against a schema after signature verification. A
 * correctly signed token whose payload no longer matches the expected shape —
 * for example one issued before a role was added — is treated as
 * unauthenticated rather than being trusted field by field.
 */
export function protect(req: Request, _res: Response, next: NextFunction): void {
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

  req.user = claimsToUser(claims.data);
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
