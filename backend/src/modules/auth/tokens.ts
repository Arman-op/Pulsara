import jwt from 'jsonwebtoken';
import { env } from '../../config/env';
import type { AccessTokenClaims } from './auth.types';

/**
 * JSON Web Token issuance and verification.
 *
 * Both secrets are required by the environment schema and have no fallback.
 * The previous implementation defaulted to the literal strings
 * `your_jwt_secret` / `your_refresh_secret`, so a deployment that forgot to set
 * them still booted and issued tokens that any reader of this repository could
 * forge.
 *
 * Access and refresh tokens are signed with *different* keys. With a shared
 * key, a stolen long-lived refresh token could be presented directly as an
 * access token and would verify.
 */

const ISSUER = 'pulsara';
const AUDIENCE = 'pulsara-api';

export type AccessTokenPayload = Omit<AccessTokenClaims, 'sub'>;

export function signAccessToken(subject: string, payload: AccessTokenPayload): string {
  return jwt.sign({ ...payload, iatMs: Date.now() }, env.JWT_ACCESS_SECRET, {
    subject,
    issuer: ISSUER,
    audience: AUDIENCE,
    expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
  });
}

export function signRefreshToken(subject: string, tokenId: string): string {
  return jwt.sign({ jti: tokenId }, env.JWT_REFRESH_SECRET, {
    subject,
    issuer: ISSUER,
    audience: AUDIENCE,
    expiresIn: `${env.REFRESH_TOKEN_TTL_DAYS}d`,
  });
}

function verify(token: string, secret: string): jwt.JwtPayload | null {
  try {
    const decoded = jwt.verify(token, secret, { issuer: ISSUER, audience: AUDIENCE });
    // A token whose payload is a bare string carries no claims we can use.
    return typeof decoded === 'string' ? null : decoded;
  } catch {
    // Signature, expiry, issuer and audience failures are all "not authenticated".
    // Distinguishing them for the caller would leak information to an attacker.
    return null;
  }
}

export const verifyAccessToken = (token: string): jwt.JwtPayload | null =>
  verify(token, env.JWT_ACCESS_SECRET);

export const verifyRefreshToken = (token: string): jwt.JwtPayload | null =>
  verify(token, env.JWT_REFRESH_SECRET);
