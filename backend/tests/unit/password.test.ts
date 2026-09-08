import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../../src/modules/auth/password';

/**
 * Password hashing.
 *
 * These assertions are about the properties that make a leaked database
 * survivable: the plaintext is not recoverable from the digest, two users with
 * the same password do not share one, and the parameters are the ones we chose
 * rather than whatever the library currently defaults to.
 */

const PASSWORD = 'correct horse battery staple';

describe('hashPassword', () => {
  it('produces an argon2id digest with the pinned parameters', () => {
    // The parameters are encoded in the digest. Asserting on them means a
    // dependency upgrade cannot quietly weaken every hash we produce.
    return hashPassword(PASSWORD).then((digest) => {
      expect(digest.startsWith('$argon2id$')).toBe(true);
      expect(digest).toContain('m=19456');
      expect(digest).toContain('t=2');
      expect(digest).toContain('p=1');
      expect(digest).not.toContain(PASSWORD);
    });
  });

  it('salts, so identical passwords do not share a digest', async () => {
    const [first, second] = await Promise.all([hashPassword(PASSWORD), hashPassword(PASSWORD)]);
    expect(first).not.toBe(second);
    // …and both still verify.
    expect(await verifyPassword(first, PASSWORD)).toBe(true);
    expect(await verifyPassword(second, PASSWORD)).toBe(true);
  });
});

describe('verifyPassword', () => {
  it('accepts the right password and rejects the wrong one', async () => {
    const digest = await hashPassword(PASSWORD);
    expect(await verifyPassword(digest, PASSWORD)).toBe(true);
    expect(await verifyPassword(digest, 'correct horse battery stapl')).toBe(false);
    expect(await verifyPassword(digest, '')).toBe(false);
  });

  it('treats a corrupt digest as a failed login rather than an error', async () => {
    // A malformed or legacy hash in the database must not become a 500 that
    // tells the caller something interesting about the account.
    expect(await verifyPassword('not-a-digest', PASSWORD)).toBe(false);
    expect(await verifyPassword('', PASSWORD)).toBe(false);
  });
});
