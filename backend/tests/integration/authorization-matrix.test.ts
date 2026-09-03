import { Role } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app';
import { disconnectDatabase, resetDatabase } from '../helpers/database';
import { signedInAs, type Session } from '../helpers/factories';

/**
 * Every mutating endpoint, and the minimum role it requires.
 *
 * The per-feature suites each check their own authorisation, which is worth
 * having and is not the same thing as this. What this catches is the failure
 * those cannot: a route added later and mounted without a guard. Nobody
 * remembers to write the negative test for a route they have just written, so
 * the list lives in one place and the assertion is generated from it.
 *
 * Keeping it honest costs one line per new endpoint. The alternative costs an
 * unguarded mutation nobody notices until it matters.
 */

type Expectation = {
  method: 'post' | 'patch' | 'delete';
  path: string;
  minimum: Role;
  /** A body that passes validation, so a 422 cannot be mistaken for a 403. */
  body?: Record<string, unknown>;
};

const UUID = '11111111-2222-3333-4444-555555555555';

const MUTATIONS: Expectation[] = [
  // Incidents: a viewer may watch an outage unfold but not act on it.
  {
    method: 'post',
    path: '/api/incidents',
    minimum: Role.MEMBER,
    body: { title: 'x', severity: 'LOW' },
  },
  {
    method: 'patch',
    path: `/api/incidents/${UUID}`,
    minimum: Role.MEMBER,
    body: { severity: 'LOW' },
  },
  {
    method: 'post',
    path: `/api/incidents/${UUID}/comments`,
    minimum: Role.MEMBER,
    body: { message: 'note' },
  },

  // The service catalogue is configuration, not operations.
  {
    method: 'post',
    path: '/api/services',
    minimum: Role.ADMIN,
    body: { name: 'x', probeType: 'HTTP', probeTarget: 'https://example.test/health' },
  },
  { method: 'patch', path: `/api/services/${UUID}`, minimum: Role.ADMIN, body: { name: 'y' } },
  { method: 'delete', path: `/api/services/${UUID}`, minimum: Role.ADMIN },

  // Administration, and the audit trail that records it.
  { method: 'patch', path: `/api/users/${UUID}`, minimum: Role.ADMIN, body: { role: 'MEMBER' } },

  // CI connections read repository data with the deployment's own credential.
  {
    method: 'post',
    path: '/api/integrations/github/connections',
    minimum: Role.ADMIN,
    body: { owner: 'octocat', name: 'hello-world' },
  },
  {
    method: 'delete',
    path: `/api/integrations/github/connections/${UUID}`,
    minimum: Role.ADMIN,
  },
  {
    method: 'post',
    path: `/api/integrations/github/connections/${UUID}/sync`,
    minimum: Role.ADMIN,
  },
];

const ROLE_RANK: Record<Role, number> = {
  [Role.VIEWER]: 0,
  [Role.MEMBER]: 1,
  [Role.ADMIN]: 2,
};

let sessions: Record<Role, Session>;

beforeAll(async () => {
  await resetDatabase();
  sessions = {
    [Role.VIEWER]: await signedInAs(Role.VIEWER),
    [Role.MEMBER]: await signedInAs(Role.MEMBER),
    [Role.ADMIN]: await signedInAs(Role.ADMIN),
  };
});

afterAll(disconnectDatabase);

function send(mutation: Expectation, token?: string) {
  const call = request(app)[mutation.method](mutation.path);
  if (token) call.set('Authorization', `Bearer ${token}`);
  return call.send(mutation.body ?? {});
}

describe('every mutating endpoint', () => {
  it.each(MUTATIONS)('$method $path refuses an anonymous caller', async (mutation) => {
    // 401 rather than 403: "who are you" and "you may not" are different
    // answers, and only the first should send a client to sign in.
    await send(mutation).expect(401);
  });

  it.each(MUTATIONS.filter((mutation) => mutation.minimum !== Role.VIEWER))(
    '$method $path refuses a role below $minimum',
    async (mutation) => {
      for (const role of [Role.VIEWER, Role.MEMBER, Role.ADMIN]) {
        if (ROLE_RANK[role] >= ROLE_RANK[mutation.minimum]) continue;

        const response = await send(mutation, sessions[role].accessToken);
        expect(
          response.status,
          `${mutation.method.toUpperCase()} ${mutation.path} as ${role}`,
        ).toBe(403);
      }
    },
  );

  it.each(MUTATIONS)('$method $path admits $minimum', async (mutation) => {
    /**
     * The permitted role must get past authorisation. What happens afterwards
     * varies — a 404 for a fixture that does not exist, a 502 for an
     * unconfigured integration — so the assertion is only that it is not a
     * refusal. Asserting success here would make this a test of ten features
     * rather than of the guard in front of them.
     */
    const response = await send(mutation, sessions[mutation.minimum].accessToken);

    expect(
      [401, 403].includes(response.status),
      `${mutation.method.toUpperCase()} ${mutation.path} as ${mutation.minimum} returned ${response.status}`,
    ).toBe(false);
  });
});

describe('reads', () => {
  it('are open to any authenticated role', async () => {
    for (const path of [
      '/api/incidents',
      '/api/services',
      '/api/deployments',
      '/api/metrics/latest',
    ]) {
      const response = await request(app)
        .get(path)
        .set('Authorization', `Bearer ${sessions[Role.VIEWER].accessToken}`);

      expect(response.status, `GET ${path} as VIEWER`).toBe(200);
    }
  });

  it('still require authentication', async () => {
    for (const path of ['/api/incidents', '/api/services', '/api/deployments']) {
      await request(app).get(path).expect(401);
    }
  });

  it('keep the audit trail and the user list to administrators', async () => {
    // Both expose who did what and when, which is sensitive in its own right.
    for (const path of ['/api/users', '/api/users/audit/log']) {
      await request(app)
        .get(path)
        .set('Authorization', `Bearer ${sessions[Role.MEMBER].accessToken}`)
        .expect(403);
    }
  });
});
