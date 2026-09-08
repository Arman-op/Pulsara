import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../../src/app';
import { disconnectDatabase, resetDatabase } from '../helpers/database';
import { signedInAs } from '../helpers/factories';
import { TEST_ORIGIN } from '../test-env';

/**
 * The API's shared contract.
 *
 * Every endpoint returns one of two envelopes, and clients branch on `success`
 * rather than guessing a route's shape. These cases hold that promise in place
 * across the error paths, where it is easiest to break.
 */

beforeEach(resetDatabase);
afterAll(disconnectDatabase);

describe('health', () => {
  it('reports liveness without touching a dependency', async () => {
    const response = await request(app).get('/api/health').expect(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.status).toBe('ok');
  });

  it('reports readiness with the database check that backs it', async () => {
    // Separate from liveness on purpose: an orchestrator restarts a container
    // that fails liveness, but only drains one that fails readiness.
    const response = await request(app).get('/api/health/ready').expect(200);
    expect(response.body.data.checks.database.reachable).toBe(true);
    expect(typeof response.body.data.checks.database.latencyMs).toBe('number');
  });

  it('is reachable without authentication', async () => {
    // A probe that needs a token is a probe that reports an outage the moment
    // the signing key rotates.
    await request(app).get('/api/health').expect(200);
  });
});

describe('the error envelope', () => {
  it('answers an unknown route in the standard shape', async () => {
    const response = await request(app).get('/api/does-not-exist').expect(404);

    expect(response.body.success).toBe(false);
    expect(typeof response.body.error.code).toBe('string');
    expect(typeof response.body.error.message).toBe('string');
  });

  it('carries a request id that also appears in the response header', async () => {
    // This is what turns "it failed at about two o'clock" into a log lookup.
    const response = await request(app).get('/api/does-not-exist').expect(404);

    expect(response.headers['x-request-id']).toBeTruthy();
    expect(response.body.error.requestId).toBe(response.headers['x-request-id']);
  });

  it('never serialises a stack trace to the client', async () => {
    // The original implementation returned `err.stack` on every failure, in
    // every environment.
    const response = await request(app).get('/api/does-not-exist').expect(404);
    expect(JSON.stringify(response.body)).not.toContain('at ');
    expect(response.body.error).not.toHaveProperty('stack');
  });

  it('reports a validation failure as 422 with the offending field', async () => {
    // 422 rather than 400: the request was well-formed JSON, it just failed the
    // schema. Clients can tell "you sent nonsense" from "you sent the wrong
    // thing" without parsing the message.
    const response = await request(app).post('/api/auth/login').send({ email: 'not-an-email' });

    expect(response.status).toBe(422);
    expect(response.body.success).toBe(false);
    expect(JSON.stringify(response.body.error.details)).toContain('password');
  });

  it('rejects a body larger than the configured limit', async () => {
    const response = await request(app)
      .post('/api/auth/login')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ email: 'a@b.test', password: 'x'.repeat(128 * 1024) }));

    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});

describe('the success envelope', () => {
  it('wraps list responses with pagination metadata', async () => {
    const admin = await signedInAs('ADMIN');

    const response = await request(app)
      .get('/api/users')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(Array.isArray(response.body.data)).toBe(true);
    expect(response.body.meta).toMatchObject({
      total: expect.any(Number),
      limit: expect.any(Number),
    });
  });

  it('rejects a pagination limit outside the permitted range', async () => {
    // An unbounded `limit` is a denial-of-service vector against the database.
    const admin = await signedInAs('ADMIN');

    await request(app)
      .get('/api/users?limit=100000')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(422);
  });
});

describe('cross-origin policy', () => {
  it('permits an allowlisted origin with credentials', async () => {
    const response = await request(app).get('/api/health').set('Origin', TEST_ORIGIN).expect(200);

    expect(response.headers['access-control-allow-origin']).toBe(TEST_ORIGIN);
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  });

  it('refuses an origin that is not on the list', async () => {
    const response = await request(app).get('/api/health').set('Origin', 'https://evil.example');
    expect(response.status).toBe(403);
  });

  it('does not advertise the server implementation', async () => {
    const response = await request(app).get('/api/health').expect(200);
    expect(response.headers['x-powered-by']).toBeUndefined();
  });
});
