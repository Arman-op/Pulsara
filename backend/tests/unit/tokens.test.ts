import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import { env } from '../../src/config/env';
import {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
} from '../../src/modules/auth/tokens';

/**
 * Token issuance and verification.
 *
 * The property worth protecting is separation: the two token types must not be
 * interchangeable, and verification must fail closed on every kind of bad
 * input rather than distinguishing between them for the caller.
 */

const SUBJECT = '11111111-2222-3333-4444-555555555555';

describe('access tokens', () => {
  it('round-trips its claims', () => {
    const token = signAccessToken(SUBJECT, { email: 'a@b.test', name: 'Ada', role: 'ADMIN' });
    const claims = verifyAccessToken(token);

    expect(claims?.sub).toBe(SUBJECT);
    expect(claims?.email).toBe('a@b.test');
    expect(claims?.role).toBe('ADMIN');
  });

  it('rejects a refresh token presented as an access token', () => {
    // The two are signed with different keys precisely so that a stolen
    // long-lived refresh token cannot be used directly against the API.
    expect(verifyAccessToken(signRefreshToken(SUBJECT, 'token-id'))).toBeNull();
  });

  it('rejects a token signed with another key', () => {
    const forged = jwt.sign({ role: 'ADMIN' }, 'an_attackers_own_signing_key_padded', {
      subject: SUBJECT,
      issuer: 'pulsara',
      audience: 'pulsara-api',
    });
    expect(verifyAccessToken(forged)).toBeNull();
  });

  it('rejects a token minted for a different audience', () => {
    const foreign = jwt.sign({ role: 'ADMIN' }, env.JWT_ACCESS_SECRET, {
      subject: SUBJECT,
      issuer: 'pulsara',
      audience: 'some-other-api',
    });
    expect(verifyAccessToken(foreign)).toBeNull();
  });

  it('rejects an expired token', () => {
    const expired = jwt.sign({ role: 'ADMIN' }, env.JWT_ACCESS_SECRET, {
      subject: SUBJECT,
      issuer: 'pulsara',
      audience: 'pulsara-api',
      expiresIn: -1,
    });
    expect(verifyAccessToken(expired)).toBeNull();
  });

  it('rejects a correctly signed token that names no issuer', () => {
    // Signed with our own key, but not minted by us — the shape a token from a
    // different service sharing the secret would have.
    const anonymous = jwt.sign({ role: 'ADMIN' }, env.JWT_ACCESS_SECRET, { subject: SUBJECT });
    expect(verifyAccessToken(anonymous)).toBeNull();
  });

  it('rejects malformed input without throwing', () => {
    expect(verifyAccessToken('')).toBeNull();
    expect(verifyAccessToken('not.a.token')).toBeNull();
  });
});

describe('refresh tokens', () => {
  it('carries the identifier of the stored row', () => {
    // Rotation looks the row up by `jti`; without it a presented token cannot
    // be tied to a revocable session.
    const claims = verifyRefreshToken(signRefreshToken(SUBJECT, 'token-id'));
    expect(claims?.jti).toBe('token-id');
    expect(claims?.sub).toBe(SUBJECT);
  });

  it('rejects an access token presented as a refresh token', () => {
    const access = signAccessToken(SUBJECT, { email: 'a@b.test', name: 'Ada', role: 'ADMIN' });
    expect(verifyRefreshToken(access)).toBeNull();
  });
});
