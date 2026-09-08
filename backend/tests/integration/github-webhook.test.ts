import { createHmac } from 'node:crypto';
import { DeploymentStatus } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../../src/app';
import { prisma } from '../../src/db/prisma';
import { disconnectDatabase, resetDatabase } from '../helpers/database';
import { TEST_WEBHOOK_SECRET } from '../test-env';

/**
 * The GitHub webhook, over HTTP.
 *
 * The unit tests cover the signature function in isolation; these cover the
 * things only the wired-up application can prove: that the raw-body parser is
 * mounted ahead of the JSON parser so the signature is computed over the bytes
 * GitHub actually sent, that a rejected delivery writes nothing, and that
 * GitHub's at-least-once delivery does not produce duplicate rows.
 */

const ENDPOINT = '/api/integrations/github/webhook';
const REPO = 'pulsara/pulsara';

beforeEach(resetDatabase);
afterAll(disconnectDatabase);

function workflowRunEvent(overrides: Record<string, unknown> = {}) {
  return {
    action: 'completed',
    repository: { id: 1, full_name: REPO },
    workflow_run: {
      id: 12345,
      name: 'CI',
      head_branch: 'main',
      head_sha: 'b'.repeat(40),
      event: 'push',
      status: 'completed',
      conclusion: 'success',
      html_url: `https://github.com/${REPO}/actions/runs/12345`,
      created_at: '2026-01-01T10:00:00Z',
      updated_at: '2026-01-01T10:04:00Z',
      run_started_at: '2026-01-01T10:00:00Z',
      actor: { login: 'octocat', avatar_url: 'https://avatars.example/octocat.png' },
      head_commit: { message: 'Ship it' },
      repository: { full_name: REPO },
      ...overrides,
    },
  };
}

/** Signs the exact bytes that will be sent, as GitHub does. */
function deliver(
  payload: unknown,
  options: { event?: string; secret?: string; body?: string } = {},
) {
  const body = options.body ?? JSON.stringify(payload);
  const signature = `sha256=${createHmac('sha256', options.secret ?? TEST_WEBHOOK_SECRET)
    .update(body)
    .digest('hex')}`;

  return request(app)
    .post(ENDPOINT)
    .set('content-type', 'application/json')
    .set('x-github-event', options.event ?? 'workflow_run')
    .set('x-github-delivery', 'delivery-1')
    .set('x-hub-signature-256', signature)
    .send(body);
}

describe('POST /api/integrations/github/webhook', () => {
  it('records a deployment from a signed workflow_run', async () => {
    await deliver(workflowRunEvent()).expect(200);

    const deployment = await prisma.deployment.findFirstOrThrow();
    expect(deployment.externalId).toBe('12345');
    expect(deployment.repo).toBe(REPO);
    expect(deployment.status).toBe(DeploymentStatus.SUCCESS);
    expect(deployment.duration).toBe(240);
  });

  it('writes nothing when the signature is wrong', async () => {
    await deliver(workflowRunEvent(), { secret: 'the_wrong_shared_secret' }).expect(401);
    expect(await prisma.deployment.count()).toBe(0);
  });

  it('rejects an unsigned delivery', async () => {
    await request(app)
      .post(ENDPOINT)
      .set('content-type', 'application/json')
      .set('x-github-event', 'workflow_run')
      .send(JSON.stringify(workflowRunEvent()))
      .expect(401);

    expect(await prisma.deployment.count()).toBe(0);
  });

  it('rejects a payload edited after it was signed', async () => {
    /**
     * The realistic attack, and the reason the raw-body parser is mounted ahead
     * of express.json(): if the signature were checked against a re-serialised
     * object, an implementation could be made to accept this.
     */
    const original = JSON.stringify(workflowRunEvent());
    const tampered = original.replace('"conclusion":"success"', '"conclusion":"failure"');
    expect(tampered).not.toBe(original);

    const signature = `sha256=${createHmac('sha256', TEST_WEBHOOK_SECRET).update(original).digest('hex')}`;

    await request(app)
      .post(ENDPOINT)
      .set('content-type', 'application/json')
      .set('x-github-event', 'workflow_run')
      .set('x-hub-signature-256', signature)
      .send(tampered)
      .expect(401);

    expect(await prisma.deployment.count()).toBe(0);
  });

  it('is idempotent, because GitHub delivers at least once', async () => {
    await deliver(workflowRunEvent()).expect(200);
    await deliver(workflowRunEvent()).expect(200);

    expect(await prisma.deployment.count()).toBe(1);
  });

  it('updates the existing row when a run finishes', async () => {
    await deliver(
      workflowRunEvent({
        status: 'in_progress',
        conclusion: null,
        updated_at: '2026-01-01T10:01:00Z',
      }),
    ).expect(200);

    const running = await prisma.deployment.findFirstOrThrow();
    expect(running.status).toBe(DeploymentStatus.RUNNING);
    expect(running.completedAt).toBeNull();

    await deliver(workflowRunEvent()).expect(200);

    const finished = await prisma.deployment.findFirstOrThrow();
    expect(finished.id).toBe(running.id);
    expect(finished.status).toBe(DeploymentStatus.SUCCESS);
  });

  it('acknowledges an event type it does not handle', async () => {
    // Replying 4xx to an unhandled event makes GitHub retry it forever and
    // eventually disable the hook.
    await deliver({ zen: 'Non-blocking is better than blocking.' }, { event: 'ping' }).expect(200);
    expect(await prisma.deployment.count()).toBe(0);
  });

  it('rejects a signed body that is not the JSON it claims to be', async () => {
    await deliver(null, { body: 'not json at all' }).expect(400);
  });
});
