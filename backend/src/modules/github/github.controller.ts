import { AuditAction } from '@prisma/client';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  env,
  githubAuthMode,
  isGitHubPollingConfigured,
  isGitHubWebhookConfigured,
} from '../../config/env';
import { prisma } from '../../db/prisma';
import { recordAudit } from '../../lib/audit';
import { NotFoundError } from '../../lib/errors';
import { sendSuccess } from '../../lib/http';
import { parseBody, parseParams, uuidParamSchema } from '../../lib/validation';
import { requireUser } from '../../middleware/auth';
import { createConnection, syncConnection } from './github.service';

/**
 * Repository connection management.
 *
 * Connections are the only piece of the CI integration an operator configures
 * locally; every run shown in the UI is pulled from GitHub.
 */

/** GitHub's own limits on the owner and repository name components. */
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

const createConnectionSchema = z.object({
  owner: z.string().trim().regex(OWNER_PATTERN, 'is not a valid GitHub owner'),
  name: z.string().trim().regex(REPO_PATTERN, 'is not a valid GitHub repository name'),
});

/**
 * Reports what the integration can actually do.
 *
 * Polling and webhooks are separate capabilities, and the UI needs to say which
 * half is missing rather than showing an empty pipeline list that looks like a
 * repository with no activity.
 */
export function getIntegrationStatus(_req: Request, res: Response): void {
  sendSuccess(res, {
    pollingConfigured: isGitHubPollingConfigured,
    webhookConfigured: isGitHubWebhookConfigured,
    /**
     * Which credential is in use, so an operator can confirm from the UI that a
     * migration from a personal token to an App actually took effect. No secret
     * is disclosed by the name of the mechanism.
     */
    authMode: githubAuthMode,
    monitoredRepository: env.GITHUB_MONITORED_REPO,
  });
}

export async function listConnections(_req: Request, res: Response): Promise<void> {
  const connections = await prisma.repoConnection.findMany({
    orderBy: [{ owner: 'asc' }, { name: 'asc' }],
    select: {
      id: true,
      provider: true,
      owner: true,
      name: true,
      defaultBranch: true,
      isActive: true,
      lastSyncedAt: true,
      lastSyncError: true,
      createdAt: true,
      _count: { select: { deployments: true } },
    },
  });

  sendSuccess(res, connections, {
    pollingConfigured: isGitHubPollingConfigured,
    webhookConfigured: isGitHubWebhookConfigured,
    authMode: githubAuthMode,
    monitoredRepository: env.GITHUB_MONITORED_REPO,
  });
}

/**
 * Registers a repository after confirming it exists and the token can read it.
 *
 * Verifying up front means a typo surfaces immediately as "repository not
 * found" instead of as a connection that silently never syncs.
 */
export async function addConnection(req: Request, res: Response): Promise<void> {
  const actor = requireUser(req);
  const { owner, name } = parseBody(req, createConnectionSchema);
  const connection = await createConnection(owner, name);

  // Populate history immediately rather than leaving the view empty until the
  // next scheduled sweep.
  await syncConnection(connection);

  recordAudit(req, actor.id, {
    action: AuditAction.REPO_CONNECTED,
    resource: 'repoConnection',
    resourceId: connection.id,
    metadata: { repository: `${owner}/${name}` },
  });

  const refreshed = await prisma.repoConnection.findUnique({ where: { id: connection.id } });
  sendSuccess(res, refreshed, undefined, 201);
}

export async function removeConnection(req: Request, res: Response): Promise<void> {
  const actor = requireUser(req);
  const { id } = parseParams(req, uuidParamSchema);

  const existing = await prisma.repoConnection.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Repository connection');

  /**
   * Deployments are kept and their connection reference set to null. Deleting
   * the delivery history because somebody disconnected a repository would
   * destroy the record of what actually shipped.
   */
  await prisma.repoConnection.delete({ where: { id } });

  recordAudit(req, actor.id, {
    action: AuditAction.REPO_DISCONNECTED,
    resource: 'repoConnection',
    resourceId: id,
    metadata: { repository: `${existing.owner}/${existing.name}` },
  });

  sendSuccess(res, { id, deleted: true });
}

/** Forces an immediate sync, for when someone does not want to wait. */
export async function syncNow(req: Request, res: Response): Promise<void> {
  const { id } = parseParams(req, uuidParamSchema);

  const connection = await prisma.repoConnection.findUnique({ where: { id } });
  if (!connection) throw new NotFoundError('Repository connection');

  const runsSeen = await syncConnection(connection);
  const refreshed = await prisma.repoConnection.findUnique({ where: { id } });

  sendSuccess(res, { connection: refreshed, runsSeen });
}
