import { Role } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../../src/app';
import { REFRESH_TOKEN_COOKIE } from '../../src/config/constants';
import { prisma } from '../../src/db/prisma';
import { disconnectDatabase, resetDatabase } from '../helpers/database';
import { createUser } from '../helpers/factories';

/**
 * Google sign-in, from a verified token onwards.
 *
 * Firebase's own verification is stubbed — proving that Google's RSA signatures
 * verify is Google's job, and reaching a real project from a test suite would
 * make the suite need credentials nobody should have to hold. What is stubbed
 * is exactly one function, and everything this file asserts happens *after* it:
 * what Pulsara does with a token it has decided to believe.
 *
 * That is where the interesting failures live. The implementation this replaces
 * set `role: 'ADMIN'` on every new federated account, so anyone with a Google
 * account who found the login page became an administrator of the dashboard.
 */

const { verifyIdToken } = vi.hoisted(() => {
  // All three must be present together or the environment schema rejects them,
  // and `isFirebaseConfigured` gates the route.
  process.env.FIREBASE_PROJECT_ID = 'pulsara-test';
  process.env.FIREBASE_CLIENT_EMAIL = 'test@pulsara-test.iam.gserviceaccount.com';
  process.env.FIREBASE_PRIVATE_KEY =
    '-----BEGIN PRIVATE KEY-----\\nnot-used\\n-----END PRIVATE KEY-----\\n';

  return { verifyIdToken: vi.fn() };
});

vi.mock('../../src/modules/auth/firebase', () => ({
  verifyFirebaseIdToken: verifyIdToken,
}));

/** The shape Firebase returns for a Google account. */
function decoded(overrides: Record<string, unknown> = {}) {
  return {
    uid: 'firebase-uid-1',
    email: 'ada@example.com',
    email_verified: true,
    name: 'Ada Lovelace',
    picture: 'https://lh3.example/ada.jpg',
    ...overrides,
  };
}

const signIn = () => request(app).post('/api/auth/firebase').send({ idToken: 'a-google-id-token' });

beforeEach(async () => {
  await resetDatabase();
  verifyIdToken.mockReset();
  verifyIdToken.mockResolvedValue(decoded());
});

afterAll(disconnectDatabase);

describe('POST /api/auth/firebase', () => {
  it('issues a Pulsara session for a verified Google account', async () => {
    const response = await signIn().expect(200);

    expect(response.body.data.user.email).toBe('ada@example.com');
    expect(typeof response.body.data.accessToken).toBe('string');

    // The same session shape as a password login: the refresh half never
    // reaches JavaScript.
    const cookie = (response.headers['set-cookie'] as unknown as string[]).find((value) =>
      value.startsWith(`${REFRESH_TOKEN_COOKIE}=`),
    );
    expect(cookie).toContain('HttpOnly');
  });

  it('makes the first account an administrator and every one after it a viewer', async () => {
    /**
     * The regression this exists for. Granting ADMIN to every federated sign-in
     * turned "has a Google account" into "administers this deployment".
     */
    const first = await signIn().expect(200);
    expect(first.body.data.user.role).toBe(Role.ADMIN);

    verifyIdToken.mockResolvedValue(decoded({ uid: 'firebase-uid-2', email: 'grace@example.com' }));
    const second = await signIn().expect(200);
    expect(second.body.data.user.role).toBe(Role.VIEWER);
  });

  it('refuses an unverified email address', async () => {
    /**
     * An unverified address may belong to somebody else entirely. Linking it
     * would let an attacker take over an existing Pulsara account by claiming
     * its email at the identity provider.
     */
    await createUser({ email: 'ada@example.com', role: Role.ADMIN });
    verifyIdToken.mockResolvedValue(decoded({ email_verified: false }));

    await signIn().expect(401);
  });

  it('refuses a token with no email at all', async () => {
    verifyIdToken.mockResolvedValue(decoded({ email: undefined }));
    await signIn().expect(401);
  });

  it('links a verified address to the existing local account', async () => {
    // Same person, second sign-in method — not a second account.
    const existing = await createUser({ email: 'ada@example.com', role: Role.MEMBER });

    const response = await signIn().expect(200);

    expect(response.body.data.user.id).toBe(existing.id);
    // The role the administrator granted survives; it is not reset by the
    // identity provider.
    expect(response.body.data.user.role).toBe(Role.MEMBER);

    const linked = await prisma.user.findUniqueOrThrow({ where: { id: existing.id } });
    expect(linked.firebaseUid).toBe('firebase-uid-1');
    expect(await prisma.user.count()).toBe(1);
  });

  it('matches an address regardless of the case the provider sends', async () => {
    const existing = await createUser({ email: 'ada@example.com' });
    verifyIdToken.mockResolvedValue(decoded({ email: 'Ada@Example.COM' }));

    const response = await signIn().expect(200);
    expect(response.body.data.user.id).toBe(existing.id);
  });

  it('refuses a deactivated account', async () => {
    await createUser({ email: 'ada@example.com', isActive: false });
    await signIn().expect(403);
  });

  it('falls back to the local part when the provider sends no name', async () => {
    verifyIdToken.mockResolvedValue(decoded({ name: undefined }));

    const response = await signIn().expect(200);
    expect(response.body.data.user.name).toBe('ada');
  });

  it('does not trust a non-string name claim', async () => {
    // `DecodedIdToken` types `name` through a catch-all index signature, so it
    // arrives unvalidated.
    verifyIdToken.mockResolvedValue(decoded({ name: { first: 'Ada' } }));

    const response = await signIn().expect(200);
    expect(response.body.data.user.name).toBe('ada');
  });

  it('rejects a token Firebase itself refuses', async () => {
    verifyIdToken.mockRejectedValue(new Error('Firebase ID token has been revoked'));
    await signIn().expect(401);
  });

  it('validates the request body', async () => {
    await request(app).post('/api/auth/firebase').send({}).expect(422);
    await request(app).post('/api/auth/firebase').send({ idToken: '' }).expect(422);
  });

  it('records the sign-in time', async () => {
    await signIn().expect(200);

    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'ada@example.com' } });
    expect(user.lastLoginAt).not.toBeNull();
  });
});
