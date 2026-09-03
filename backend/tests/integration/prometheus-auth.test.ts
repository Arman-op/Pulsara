import request from 'supertest';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { app } from '../../src/app';
import { prisma } from '../../src/db/prisma';

/**
 * The optional bearer token on the scrape endpoint.
 *
 * `vi.hoisted` runs before this file's imports, which is exactly what is needed
 * here: `src/config/env.ts` reads and validates the environment at import time —
 * that is the whole point of it — and `src/app.ts` pulls it in transitively via
 * the Prisma client. Assigning the token in the file body, or even in
 * `beforeAll`, would set it after the configuration had already been frozen
 * without it, and every assertion below would pass against an unprotected
 * endpoint for the wrong reason.
 */
const TOKEN = vi.hoisted(() => {
  const value = 'a_scrape_token_long_enough_to_pass';
  process.env.METRICS_SCRAPE_TOKEN = value;
  return value;
});

afterAll(async () => {
  delete process.env.METRICS_SCRAPE_TOKEN;
  await prisma.$disconnect();
});

describe('GET /metrics with METRICS_SCRAPE_TOKEN set', () => {
  it('serves a scrape carrying the token', async () => {
    const response = await request(app)
      .get('/metrics')
      .set('Authorization', `Bearer ${TOKEN}`)
      .expect(200);

    expect(response.text).toContain('pulsara_build_info');
  });

  it('rejects a scrape with no credentials', async () => {
    // The response names every monitored service, reports host saturation and
    // counts open incidents: enough to describe the shape and the current weak
    // points of a deployment to anyone who asks.
    await request(app).get('/metrics').expect(401);
  });

  it('rejects the wrong token, and one that is merely a prefix of the right one', async () => {
    await request(app).get('/metrics').set('Authorization', 'Bearer nope').expect(401);
    await request(app)
      .get('/metrics')
      .set('Authorization', `Bearer ${TOKEN.slice(0, -1)}`)
      .expect(401);
  });

  it('rejects a non-bearer scheme rather than trying to interpret it', async () => {
    await request(app).get('/metrics').set('Authorization', `Basic ${TOKEN}`).expect(401);
  });

  it('answers a rejected scrape in the standard error envelope', async () => {
    // /metrics serves text on success, but a failure is an API error like any
    // other and should be greppable by request id alongside the rest.
    const response = await request(app).get('/metrics').expect(401);
    expect(response.body.success).toBe(false);
    expect(response.body.error.requestId).toBeTruthy();
  });
});
