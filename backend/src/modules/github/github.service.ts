import type { RepoConnection } from '@prisma/client';
import { CiProvider } from '@prisma/client';
import { env } from '../../config/env';
import { prisma } from '../../db/prisma';
import { logger } from '../../lib/logger';
import {
  getRepository,
  listRunJobs,
  listWorkflowRuns,
  type GitHubWorkflowJob,
  type GitHubWorkflowRun,
} from './github.client';
import { mapWorkflowJob, mapWorkflowRun } from './github.mapper';

/**
 * Persistence for GitHub-sourced delivery data.
 *
 * Everything here is an upsert keyed on the provider's own id. Webhook delivery
 * is at-least-once and overlaps with the backfill poll, so the same run arrives
 * repeatedly and by more than one path; inserting would produce duplicate
 * pipeline rows for a single deployment.
 */

/** Truncates a message to fit the column, keeping the useful prefix. */
const MAX_SYNC_ERROR_LENGTH = 500;

export async function upsertDeploymentFromRun(
  run: GitHubWorkflowRun,
  repoFullName: string,
): Promise<string> {
  const mapped = mapWorkflowRun(run, repoFullName);

  const connection = await prisma.repoConnection.findFirst({
    where: {
      provider: CiProvider.GITHUB,
      owner: mapped.repo.split('/')[0] ?? '',
      name: mapped.repo.split('/')[1] ?? '',
    },
    select: { id: true },
  });

  const deployment = await prisma.deployment.upsert({
    where: {
      provider_externalId: { provider: CiProvider.GITHUB, externalId: mapped.externalId },
    },
    create: {
      ...mapped,
      provider: CiProvider.GITHUB,
      repoConnectionId: connection?.id ?? null,
    },
    update: {
      // `createdAt` is deliberately not touched: a re-delivery must not make an
      // old run look new and jump to the top of the history.
      status: mapped.status,
      duration: mapped.duration,
      completedAt: mapped.completedAt,
      startedAt: mapped.startedAt,
      workflowName: mapped.workflowName,
      commitMessage: mapped.commitMessage,
      actorLogin: mapped.actorLogin,
      actorAvatarUrl: mapped.actorAvatarUrl,
      repoConnectionId: connection?.id ?? null,
    },
    select: { id: true },
  });

  return deployment.id;
}

export async function upsertStageFromJob(job: GitHubWorkflowJob): Promise<void> {
  const mapped = mapWorkflowJob(job);

  const deployment = await prisma.deployment.findUnique({
    where: {
      provider_externalId: { provider: CiProvider.GITHUB, externalId: String(job.run_id) },
    },
    select: { id: true },
  });

  /**
   * A `workflow_job` delivery can arrive before the `workflow_run` that owns it;
   * GitHub does not guarantee ordering between the two. Dropping the job is
   * correct rather than fabricating a parent deployment from a job payload that
   * does not carry the run's branch, commit or actor — the next sync picks up
   * the jobs once the run exists.
   */
  if (!deployment) {
    logger.debug({ runId: job.run_id, jobId: job.id }, 'Job arrived before its run; skipping');
    return;
  }

  await prisma.stage.upsert({
    where: {
      deploymentId_externalId: { deploymentId: deployment.id, externalId: mapped.externalId },
    },
    create: { ...mapped, deploymentId: deployment.id },
    update: {
      status: mapped.status,
      duration: mapped.duration,
      startedAt: mapped.startedAt,
      completedAt: mapped.completedAt,
    },
  });
}

/**
 * Pulls recent runs for one connection.
 *
 * Backfill exists because webhooks only cover what happens after the hook is
 * installed, and because a delivery can be missed while the service is
 * redeploying. It is the reconciling half of the pair: webhooks make the data
 * fresh, polling makes it correct.
 */
export async function syncConnection(connection: RepoConnection): Promise<number> {
  try {
    const result = await listWorkflowRuns(
      connection.owner,
      connection.name,
      env.GITHUB_BACKFILL_RUNS,
      connection.lastEtag,
    );

    if (result.notModified) {
      await prisma.repoConnection.update({
        where: { id: connection.id },
        data: { lastSyncedAt: new Date(), lastSyncError: null },
      });
      return 0;
    }

    const repoFullName = `${connection.owner}/${connection.name}`;

    for (const run of result.data) {
      const deploymentId = await upsertDeploymentFromRun(run, repoFullName);

      /**
       * Jobs are only fetched for runs that have finished or are in flight, and
       * one request per run is a real cost against the rate limit. Queued runs
       * have no jobs worth recording yet.
       */
      if (run.status === 'queued') continue;

      try {
        const jobs = await listRunJobs(connection.owner, connection.name, String(run.id));
        for (const job of jobs) {
          await upsertStageFromJob({ ...job, run_id: run.id });
        }
      } catch (error) {
        // A failure fetching one run's jobs must not abandon the whole sync.
        logger.warn(
          { err: error, runId: run.id, deploymentId },
          'Could not fetch jobs for run; deployment recorded without stages',
        );
      }
    }

    await prisma.repoConnection.update({
      where: { id: connection.id },
      data: { lastSyncedAt: new Date(), lastEtag: result.etag, lastSyncError: null },
    });

    return result.data.length;
  } catch (error) {
    /**
     * The failure is recorded on the connection rather than only logged, so the
     * UI can say "this repository could not be synced, here is why" instead of
     * showing an empty pipeline list that looks like a quiet repository.
     */
    const message = error instanceof Error ? error.message : String(error);
    await prisma.repoConnection.update({
      where: { id: connection.id },
      data: {
        lastSyncedAt: new Date(),
        lastSyncError: message.slice(0, MAX_SYNC_ERROR_LENGTH),
      },
    });
    logger.error(
      { err: error, repo: `${connection.owner}/${connection.name}` },
      'GitHub sync failed for connection',
    );
    return 0;
  }
}

export async function syncAllConnections(): Promise<void> {
  const connections = await prisma.repoConnection.findMany({ where: { isActive: true } });

  // Sequential on purpose. Connections share one rate-limit budget, so running
  // them in parallel only makes the budget run out faster.
  for (const connection of connections) {
    await syncConnection(connection);
  }
}

/** Verifies a repository is reachable before storing the connection. */
export async function createConnection(owner: string, name: string): Promise<RepoConnection> {
  const repository = await getRepository(owner, name);

  return prisma.repoConnection.upsert({
    where: { provider_owner_name: { provider: CiProvider.GITHUB, owner, name } },
    create: {
      provider: CiProvider.GITHUB,
      owner,
      name,
      externalId: String(repository.id),
      defaultBranch: repository.default_branch,
    },
    update: {
      externalId: String(repository.id),
      defaultBranch: repository.default_branch,
      isActive: true,
      lastSyncError: null,
    },
  });
}

/**
 * Registers and backfills the repository named by GITHUB_MONITORED_REPO.
 *
 * Without this, a correctly configured deployment still shows an empty
 * pipelines page until somebody remembers to POST a connection — which reads
 * exactly like a broken integration. Naming the repository in configuration
 * means the page has real content on first boot.
 *
 * Failure is logged and swallowed. A GitHub outage, a revoked token or a
 * repository that has been renamed must not stop the API from starting: every
 * other part of the product works without CI data, and the connection's
 * `lastSyncError` is where the reason belongs.
 */
export async function ensureMonitoredRepository(): Promise<void> {
  const [owner, name] = env.GITHUB_MONITORED_REPO.split('/');

  // The environment schema enforces the `owner/name` shape, so both halves are
  // present by the time this runs.
  if (!owner || !name) return;

  const existing = await prisma.repoConnection.findUnique({
    where: { provider_owner_name: { provider: CiProvider.GITHUB, owner, name } },
  });

  /**
   * An existing connection is left alone. Re-verifying and re-backfilling on
   * every boot would spend rate limit re-reading runs already stored, and would
   * quietly resurrect a repository an operator had deliberately disconnected.
   */
  if (existing) {
    logger.debug(
      { repository: env.GITHUB_MONITORED_REPO },
      'Monitored repository already connected',
    );
    return;
  }

  try {
    const connection = await createConnection(owner, name);
    const runs = await syncConnection(connection);
    logger.info(
      { repository: env.GITHUB_MONITORED_REPO, runs },
      'Connected and backfilled the monitored repository',
    );
  } catch (error) {
    logger.error(
      { err: error, repository: env.GITHUB_MONITORED_REPO },
      'Could not connect the monitored repository; the pipelines view will report it as not connected',
    );
  }
}

export type GitHubSyncJob = { stop: () => void };

export function startGitHubSync(): GitHubSyncJob {
  let running = false;

  const tick = () => {
    if (running) return;
    running = true;
    void syncAllConnections()
      .catch((error: unknown) => logger.error({ err: error }, 'GitHub sync sweep failed'))
      .finally(() => {
        running = false;
      });
  };

  tick();
  const timer = setInterval(tick, env.GITHUB_SYNC_INTERVAL_MS);

  logger.info({ intervalMs: env.GITHUB_SYNC_INTERVAL_MS }, 'GitHub sync started');

  return { stop: () => clearInterval(timer) };
}
