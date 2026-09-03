import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { env } from '../../config/env';
import { BadRequestError, UnauthenticatedError, UpstreamUnavailableError } from '../../lib/errors';
import { sendSuccess } from '../../lib/http';
import { logger } from '../../lib/logger';
import type { GitHubWorkflowJob, GitHubWorkflowRun } from './github.client';
import { upsertDeploymentFromRun, upsertStageFromJob } from './github.service';

/**
 * GitHub webhook receiver.
 *
 * This endpoint is reachable by anyone on the internet, so the signature check
 * is the only thing standing between GitHub's payloads and forged deployment
 * records. It is done first, before the body is parsed or inspected.
 */

const SIGNATURE_HEADER = 'x-hub-signature-256';
const EVENT_HEADER = 'x-github-event';
const DELIVERY_HEADER = 'x-github-delivery';

const SIGNATURE_PREFIX = 'sha256=';

/**
 * Verifies GitHub's HMAC-SHA256 signature over the exact bytes received.
 *
 * Two details are load-bearing:
 *
 *  - The digest must be computed over the **raw** body. `JSON.parse` followed by
 *    `JSON.stringify` does not round-trip byte-for-byte (key order, unicode
 *    escapes, whitespace), so verifying a re-serialised body rejects valid
 *    deliveries and, worse, invites someone to "fix" it by skipping the check.
 *  - The comparison is `timingSafeEqual`, not `===`. A normal string comparison
 *    returns as soon as it finds a differing byte, which leaks how much of a
 *    guessed signature was correct and makes the digest forgeable one byte at a
 *    time.
 */
export function verifySignature(rawBody: Buffer, signatureHeader: string | undefined): void {
  if (!env.GITHUB_WEBHOOK_SECRET) {
    throw new UpstreamUnavailableError('GitHub webhooks are not configured on this deployment');
  }

  if (!signatureHeader?.startsWith(SIGNATURE_PREFIX)) {
    throw new UnauthenticatedError('Missing or malformed webhook signature');
  }

  const expected = Buffer.from(
    SIGNATURE_PREFIX +
      createHmac('sha256', env.GITHUB_WEBHOOK_SECRET).update(rawBody).digest('hex'),
    'utf8',
  );
  const received = Buffer.from(signatureHeader, 'utf8');

  // timingSafeEqual throws on a length mismatch, which would itself be a
  // side channel, so the lengths are compared first and both paths reject
  // identically.
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new UnauthenticatedError('Webhook signature verification failed');
  }
}

type WorkflowRunEvent = {
  action: string;
  workflow_run: GitHubWorkflowRun;
  repository: { id: number; full_name: string };
};

type WorkflowJobEvent = {
  action: string;
  workflow_job: GitHubWorkflowJob;
  repository: { id: number; full_name: string };
};

/**
 * Handles a delivery.
 *
 * GitHub retries on any non-2xx response and expects a reply within ten
 * seconds. Work is therefore kept to a single upsert, and unrecognised events
 * are acknowledged rather than rejected — replying 4xx to an event type we
 * simply do not handle would make GitHub retry it forever and eventually
 * disable the hook.
 */
export async function handleWebhook(req: Request, res: Response): Promise<void> {
  // express.raw() leaves the body as a Buffer, but the Express type is `any`.
  const rawBody: unknown = req.body;

  if (!Buffer.isBuffer(rawBody)) {
    // Guards against the raw-body parser being removed or reordered behind the
    // JSON parser, which would silently disable signature verification.
    throw new BadRequestError('Webhook body was not captured as raw bytes');
  }

  verifySignature(rawBody, req.get(SIGNATURE_HEADER));

  const event = req.get(EVENT_HEADER);
  const deliveryId = req.get(DELIVERY_HEADER);

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new BadRequestError('Webhook body is not valid JSON');
  }

  const log = req.log ?? logger;

  switch (event) {
    case 'ping':
      log.info({ deliveryId }, 'GitHub webhook ping received');
      break;

    case 'workflow_run': {
      const body = payload as WorkflowRunEvent;
      await upsertDeploymentFromRun(body.workflow_run, body.repository.full_name);
      log.info(
        { deliveryId, runId: body.workflow_run.id, action: body.action },
        'Recorded workflow run from webhook',
      );
      break;
    }

    case 'workflow_job': {
      const body = payload as WorkflowJobEvent;
      await upsertStageFromJob(body.workflow_job);
      log.info(
        { deliveryId, jobId: body.workflow_job.id, action: body.action },
        'Recorded workflow job from webhook',
      );
      break;
    }

    default:
      log.debug({ deliveryId, event }, 'Ignoring unhandled GitHub event');
  }

  // Always 200 once the signature is valid: the delivery was accepted, even if
  // this build does not act on that event type.
  sendSuccess(res, { received: true, event: event ?? null });
}
