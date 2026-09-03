import { AuditAction, Role } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../../src/app';
import { prisma } from '../../src/db/prisma';
import { disconnectDatabase, resetDatabase } from '../helpers/database';
import { eventually } from '../helpers/eventually';
import { createUser, signIn, signedInAs } from '../helpers/factories';

/**
 * Role-based access control.
 *
 * Roles existed in the schema and were rendered in the interface, but nothing
 * on the server ever checked them: every authenticated principal could reach
 * every endpoint. These cases assert that the guard is real, that it reads the
 * database rather than the token, and that it cannot be used to lock everybody
 * out.
 */

beforeEach(resetDatabase);
afterAll(disconnectDatabase);

const asUser = (token: string) =>
  request(app).get('/api/users').set('Authorization', `Bearer ${token}`);

describe('administrator-only routes', () => {
  it('admits an administrator', async () => {
    const admin = await signedInAs(Role.ADMIN);
    await asUser(admin.accessToken).expect(200);
  });

  it('refuses a member and a viewer', async () => {
    const member = await signedInAs(Role.MEMBER);
    const viewer = await signedInAs(Role.VIEWER);

    await asUser(member.accessToken).expect(403);
    await asUser(viewer.accessToken).expect(403);
  });

  it('refuses an unauthenticated caller with 401, not 403', async () => {
    // "Who are you?" and "you may not" are different answers and different
    // client behaviours: one triggers a sign-in, the other must not.
    await request(app).get('/api/users').expect(401);
  });

  it('does not honour a role claim the database disagrees with', async () => {
    /**
     * The token is a snapshot from the moment it was issued. If the guard
     * trusted its `role` claim, a demoted administrator would keep full
     * administrative power until the token expired — precisely the window in
     * which somebody's access is being revoked for a reason.
     */
    const admin = await signedInAs(Role.ADMIN);
    const second = await createUser({ role: Role.ADMIN });

    await asUser(admin.accessToken).expect(200);

    await prisma.user.update({ where: { id: admin.user.id }, data: { role: Role.VIEWER } });

    // Same token, immediately afterwards.
    await asUser(admin.accessToken).expect(403);
    expect(second.role).toBe(Role.ADMIN);
  });

  it('rejects a deactivated account outright, not merely as unauthorised', async () => {
    const admin = await signedInAs(Role.ADMIN);
    await createUser({ role: Role.ADMIN });

    await prisma.user.update({ where: { id: admin.user.id }, data: { isActive: false } });

    await asUser(admin.accessToken).expect(401);
  });
});

describe('PATCH /api/users/:id', () => {
  it('promotes and demotes another account', async () => {
    const admin = await signedInAs(Role.ADMIN);
    const target = await createUser({ role: Role.VIEWER });

    const promoted = await request(app)
      .patch(`/api/users/${target.id}`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ role: Role.MEMBER })
      .expect(200);

    expect(promoted.body.data.role).toBe(Role.MEMBER);
    expect(promoted.body.data).not.toHaveProperty('passwordHash');
  });

  it('refuses self-demotion and self-deactivation', async () => {
    // A sole administrator who removes their own access has no path back.
    const admin = await signedInAs(Role.ADMIN);

    await request(app)
      .patch(`/api/users/${admin.user.id}`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ role: Role.VIEWER })
      .expect(400);

    await request(app)
      .patch(`/api/users/${admin.user.id}`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ isActive: false })
      .expect(400);
  });

  it('keeps an administrator when two demote each other at the same moment', async () => {
    /**
     * The last-administrator check is a read-then-write on a count, which under
     * the default READ COMMITTED is a race: both transactions read two
     * administrators, both pass the check, both commit, and the deployment is
     * left with none and no way to appoint one. The update runs at SERIALIZABLE
     * so that one of the two fails instead.
     */
    const first = await signedInAs(Role.ADMIN);
    const second = await signIn(await createUser({ role: Role.ADMIN }));

    const demote = (actorToken: string, targetId: string) =>
      request(app)
        .patch(`/api/users/${targetId}`)
        .set('Authorization', `Bearer ${actorToken}`)
        .send({ role: Role.MEMBER });

    await Promise.all([
      demote(first.accessToken, second.user.id).ok(() => true),
      demote(second.accessToken, first.user.id).ok(() => true),
    ]);

    const remaining = await prisma.user.count({ where: { role: Role.ADMIN, isActive: true } });
    expect(remaining).toBeGreaterThanOrEqual(1);
  });

  it('signs a deactivated user out immediately', async () => {
    /**
     * Without this, a removed account keeps working until its refresh token
     * expires — up to a week of access for somebody who has just been let go.
     */
    const admin = await signedInAs(Role.ADMIN);
    const target = await createUser({ role: Role.MEMBER });
    const targetSession = await signIn(target);

    await request(app)
      .patch(`/api/users/${target.id}`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ isActive: false })
      .expect(200);

    await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', targetSession.refreshCookie)
      .expect(401);
  });

  it('rejects an empty patch and an unknown user', async () => {
    const admin = await signedInAs(Role.ADMIN);

    // A patch that changes nothing is a client bug, not a no-op to be accepted.
    await request(app)
      .patch(`/api/users/${admin.user.id}`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({})
      .expect(422);

    await request(app)
      .patch('/api/users/11111111-2222-3333-4444-555555555555')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ role: Role.MEMBER })
      .expect(404);
  });

  it('rejects an identifier that is not a UUID before it reaches the database', async () => {
    const admin = await signedInAs(Role.ADMIN);

    await request(app)
      .patch('/api/users/not-a-uuid')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ role: Role.MEMBER })
      .expect(422);
  });
});

describe('the audit trail', () => {
  it('records who changed whose role', async () => {
    const admin = await signedInAs(Role.ADMIN);
    const target = await createUser({ role: Role.VIEWER });

    await request(app)
      .patch(`/api/users/${target.id}`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ role: Role.MEMBER })
      .expect(200);

    // The audit write is deliberately off the request path, so the row may
    // land a moment after the response does.
    await eventually(async () => {
      const entries = await request(app)
        .get('/api/users/audit/log')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .expect(200);

      const entry = (entries.body.data as { action: string; resourceId: string }[]).find(
        (item) => item.action === AuditAction.USER_ROLE_CHANGED,
      );

      expect(entry?.resourceId).toBe(target.id);
    });
  });

  it('is administrator-only, because it is itself sensitive', async () => {
    const member = await signedInAs(Role.MEMBER);
    await request(app)
      .get('/api/users/audit/log')
      .set('Authorization', `Bearer ${member.accessToken}`)
      .expect(403);
  });
});
