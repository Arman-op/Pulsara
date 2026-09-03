import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../../src/app';
import { REFRESH_TOKEN_COOKIE } from '../../src/config/constants';
import { prisma } from '../../src/db/prisma';
import { disconnectDatabase, resetDatabase } from '../helpers/database';
import { TEST_PASSWORD, createUser, readCookie, signIn } from '../helpers/factories';

/**
 * Authentication, end to end, against a real database.
 *
 * The login endpoint this replaces accepted **any** email address with the
 * password "password" and minted an admin session for it. The first two cases
 * exist so that regression cannot come back unnoticed.
 */

beforeEach(resetDatabase);
afterAll(disconnectDatabase);

const login = (email: string, password: string) =>
  request(app).post('/api/auth/login').send({ email, password });

describe('POST /api/auth/login', () => {
  it('rejects an address that has no account', async () => {
    const response = await login('nobody@pulsara.test', TEST_PASSWORD);
    expect(response.status).toBe(401);
    expect(response.body.success).toBe(false);
  });

  it('rejects the right address with the wrong password', async () => {
    const user = await createUser();
    expect((await login(user.email, 'not the password')).status).toBe(401);
  });

  it('does not reveal whether an address is registered', async () => {
    // Different messages here turn the login form into an account enumerator.
    const user = await createUser();
    const unknown = await login('nobody@pulsara.test', 'whatever');
    const wrongPassword = await login(user.email, 'whatever');

    expect(unknown.body.error.message).toBe(wrongPassword.body.error.message);
    expect(unknown.body.error.code).toBe(wrongPassword.body.error.code);
  });

  it('issues a session for valid credentials', async () => {
    const user = await createUser({ role: 'MEMBER' });
    const response = await login(user.email, TEST_PASSWORD).expect(200);

    expect(response.body.data.user.email).toBe(user.email);
    expect(response.body.data.user.role).toBe('MEMBER');
    expect(typeof response.body.data.accessToken).toBe('string');
    // The password digest must never leave the server.
    expect(JSON.stringify(response.body)).not.toContain('argon2');
  });

  it('puts the refresh token in an HttpOnly cookie and nowhere else', async () => {
    const user = await createUser();
    const response = await login(user.email, TEST_PASSWORD).expect(200);

    const setCookie = response.headers['set-cookie'] as unknown as string[];
    const cookie = setCookie.find((value) => value.startsWith(`${REFRESH_TOKEN_COOKIE}=`));

    expect(cookie).toBeDefined();
    expect(cookie).toContain('HttpOnly');
    // Scoped to the only route that consumes it, so it is not attached to every
    // API request the dashboard makes.
    expect(cookie).toContain('Path=/api/auth');
    expect(response.body.data).not.toHaveProperty('refreshToken');
  });

  it('matches an address regardless of the case it was typed in', async () => {
    const user = await createUser({ email: 'ada@pulsara.test' });
    await login('Ada@Pulsara.TEST', TEST_PASSWORD).expect(200);
    expect(user.email).toBe('ada@pulsara.test');
  });

  it('refuses a deactivated account', async () => {
    /**
     * 403 rather than 401, and a distinct message: the credentials are correct,
     * so telling the user to contact an administrator is more useful than
     * "wrong password" and sends them somewhere. It is not an enumeration leak
     * — reaching this branch requires already knowing the password.
     */
    const user = await createUser({ isActive: false });
    expect((await login(user.email, TEST_PASSWORD)).status).toBe(403);
  });

  it('refuses an account that has no local password', async () => {
    // Federated-only accounts have a null digest. Treating "no password set" as
    // "any password matches" is a classic way to lose an entire user base.
    const user = await createUser({ password: null });
    expect((await login(user.email, TEST_PASSWORD)).status).toBe(401);
    expect((await login(user.email, '')).status).toBeGreaterThanOrEqual(400);
  });

  it('records the sign-in time', async () => {
    const user = await createUser();
    expect(user.lastLoginAt).toBeNull();

    await login(user.email, TEST_PASSWORD).expect(200);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.lastLoginAt).not.toBeNull();
  });
});

describe('POST /api/auth/refresh', () => {
  it('exchanges the cookie for a new access token', async () => {
    const session = await signIn(await createUser());

    const response = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', session.refreshCookie)
      .expect(200);

    expect(typeof response.body.data.accessToken).toBe('string');
  });

  it('rotates the token, so the presented one stops working', async () => {
    const session = await signIn(await createUser());

    const rotated = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', session.refreshCookie)
      .expect(200);

    const next = readCookie(
      rotated.headers['set-cookie'] as unknown as string[],
      REFRESH_TOKEN_COOKIE,
    );
    expect(next).not.toBe(session.refreshCookie);

    // The new one works…
    await request(app).post('/api/auth/refresh').set('Cookie', next).expect(200);
  });

  it('revokes every session when a rotated token is replayed', async () => {
    /**
     * Replay of a superseded token means one of two things: the token was
     * stolen, or the legitimate client is confused. Neither is safe to serve,
     * and the server cannot tell which is which — so the whole family goes.
     *
     * This test caught a real bug: the mass revocation originally ran inside
     * the transaction that then threw to reject the request, so the rollback
     * undid the revocation and the stolen token kept working.
     */
    const session = await signIn(await createUser());

    await request(app).post('/api/auth/refresh').set('Cookie', session.refreshCookie).expect(200);

    // Replaying the original, now-superseded token.
    await request(app).post('/api/auth/refresh').set('Cookie', session.refreshCookie).expect(401);

    const live = await prisma.refreshToken.count({
      where: { userId: session.user.id, revokedAt: null },
    });
    expect(live).toBe(0);
  });

  it('rejects a request with no cookie', async () => {
    await request(app).post('/api/auth/refresh').expect(401);
  });

  it('rejects a forged cookie', async () => {
    await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', `${REFRESH_TOKEN_COOKIE}=not.a.real.token`)
      .expect(401);
  });
});

describe('POST /api/auth/logout', () => {
  it('revokes the presented session', async () => {
    const session = await signIn(await createUser());

    await request(app).post('/api/auth/logout').set('Cookie', session.refreshCookie).expect(200);

    await request(app).post('/api/auth/refresh').set('Cookie', session.refreshCookie).expect(401);
  });

  it('succeeds even without a session, so signing out is never stuck', async () => {
    await request(app).post('/api/auth/logout').expect(200);
  });
});

describe('GET /api/auth/me', () => {
  it('returns the caller', async () => {
    const session = await signIn(await createUser({ name: 'Ada Lovelace' }));

    const response = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .expect(200);

    expect(response.body.data.name).toBe('Ada Lovelace');
  });

  it('rejects a missing, malformed or forged token', async () => {
    await request(app).get('/api/auth/me').expect(401);
    await request(app).get('/api/auth/me').set('Authorization', 'Bearer nonsense').expect(401);
    await request(app).get('/api/auth/me').set('Authorization', 'Basic abc').expect(401);
  });

  it('rejects a valid token belonging to a deleted account', async () => {
    // The token is still signed and unexpired; the account behind it is gone.
    const session = await signIn(await createUser());
    await prisma.user.delete({ where: { id: session.user.id } });

    await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .expect(401);
  });
});

describe('GET /api/auth/sessions', () => {
  it('lists live sessions and revokes them on request', async () => {
    const user = await createUser();
    const first = await signIn(user);
    await signIn(user);

    const listed = await request(app)
      .get('/api/auth/sessions')
      .set('Authorization', `Bearer ${first.accessToken}`)
      .expect(200);
    expect(listed.body.data).toHaveLength(2);

    await request(app)
      .delete('/api/auth/sessions')
      .set('Authorization', `Bearer ${first.accessToken}`)
      .expect(200);

    expect(await prisma.refreshToken.count({ where: { userId: user.id, revokedAt: null } })).toBe(
      0,
    );
  });
});
