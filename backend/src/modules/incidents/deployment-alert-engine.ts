import { DeploymentStatus, Severity } from '@prisma/client';
import { env } from '../../config/env';
import { prisma } from '../../db/prisma';
import { logger } from '../../lib/logger';
import { openOrEscalateIncident, resolveAutomatedIncident } from './incident-store';

/**
 * Alerting from delivery failures.
 *
 * The third source of automated incidents, after service reachability and host
 * resource pressure. A broken build on the branch that ships is an operational
 * problem — nothing can be released until it is fixed — and it belongs in the
 * same feed as an outage rather than in a separate place people forget to look.
 *
 * Two decisions shape everything below.
 */

/**
 * The condition is "the latest run of this workflow on this branch is failing",
 * evaluated from stored state — not "a failed run just arrived".
 *
 * Reacting per delivery would be wrong in three ways at once. Backfilling a
 * repository would open incidents for builds that failed and were fixed last
 * week. Webhook deliveries have no ordering guarantee, so a late-arriving
 * failure could reopen a condition a later success had already cleared. And a
 * re-run of the same broken build would look like a second, separate problem.
 *
 * Deciding from the newest finished run makes all three cases fall out
 * correctly and makes the whole engine idempotent: evaluating twice changes
 * nothing.
 */
type DeploymentKey = { repo: string; workflowName: string | null; branch: string };

/**
 * Only the default branch alerts.
 *
 * A failing build on a feature branch is a developer mid-work, not an incident.
 * Opening one for every failed pull-request run would bury the outages this
 * feed exists to surface, and the predictable response — muting it — costs the
 * real alerts too.
 */
async function isDefaultBranch(repo: string, branch: string): Promise<boolean> {
  const [owner, name] = repo.split('/');
  if (!owner || !name) return false;

  const connection = await prisma.repoConnection.findFirst({
    where: { owner, name },
    select: { defaultBranch: true },
  });

  /**
   * An unknown default branch means we cannot tell a release build from a
   * feature build, and guessing `main` would be wrong for every repository that
   * still uses `master` or something else entirely. Staying quiet is the honest
   * failure: a missed alert is recoverable, a stream of false ones is not.
   */
  return connection?.defaultBranch === branch;
}

function dedupeKeyFor(key: DeploymentKey): string {
  return `deployment-failure:${key.repo}:${key.workflowName ?? 'unnamed'}:${key.branch}`;
}

function describe(key: DeploymentKey, consecutive: number): string {
  const workflow = key.workflowName ?? 'The workflow';
  const runs = consecutive === 1 ? 'run' : 'consecutive runs';
  return `${workflow} has failed on ${key.repo}@${key.branch} for ${consecutive} ${runs}`;
}

/**
 * Counts how many of the most recent finished runs failed in a row.
 *
 * Counted from the database rather than from a counter held in memory: webhooks
 * and the reconciling poll both write here, the process restarts, and a run can
 * arrive out of order. The stored history is the only account of this that is
 * actually true.
 */
function countConsecutiveFailures(recent: { status: DeploymentStatus }[]): number {
  let count = 0;
  for (const run of recent) {
    if (run.status !== DeploymentStatus.FAILED) break;
    count += 1;
  }
  return count;
}

/** A build broken for several runs running is worse than one that just broke. */
function severityFor(consecutiveFailures: number): Severity {
  return consecutiveFailures >= env.DEPLOYMENT_FAILURE_ESCALATION_RUNS
    ? Severity.CRITICAL
    : Severity.HIGH;
}

/**
 * Decides whether a workflow's current state warrants an open incident.
 *
 * Called after a run is recorded, by both the webhook receiver and the sync
 * sweep. Failures are logged rather than propagated: an alerting problem must
 * never stop the mirroring that feeds it.
 */
export async function evaluateDeploymentHealth(key: DeploymentKey): Promise<void> {
  if (!env.DEPLOYMENT_ALERTS_ENABLED) return;

  try {
    if (!(await isDefaultBranch(key.repo, key.branch))) return;

    /**
     * Only finished runs are considered. A queued or in-flight run says nothing
     * about whether the branch is broken, and treating one as a recovery would
     * clear an incident the moment somebody pushed a retry.
     */
    const recent = await prisma.deployment.findMany({
      where: {
        repo: key.repo,
        branch: key.branch,
        workflowName: key.workflowName,
        status: {
          in: [DeploymentStatus.SUCCESS, DeploymentStatus.FAILED, DeploymentStatus.CANCELED],
        },
      },
      orderBy: { createdAt: 'desc' },
      take: env.DEPLOYMENT_FAILURE_ESCALATION_RUNS + 1,
      select: { status: true, externalUrl: true },
    });

    const latest = recent[0];
    if (!latest) return;

    const dedupeKey = dedupeKeyFor(key);
    const subject = `${key.repo}@${key.branch}`;

    /**
     * A cancelled run is usually somebody superseding their own push. It is
     * neither a failure nor evidence of recovery, so the incident — open or
     * not — is left exactly as it was.
     */
    if (latest.status === DeploymentStatus.CANCELED) return;

    if (latest.status === DeploymentStatus.SUCCESS) {
      await resolveAutomatedIncident(
        dedupeKey,
        subject,
        () => `${key.workflowName ?? 'The workflow'} passed again on ${subject}`,
      );
      return;
    }

    const consecutive = countConsecutiveFailures(recent);

    await openOrEscalateIncident({
      dedupeKey,
      title: `${key.workflowName ?? 'Workflow'} failing on ${key.branch}`,
      description: latest.externalUrl
        ? `${describe(key, consecutive)}. Latest run: ${latest.externalUrl}`
        : describe(key, consecutive),
      severity: severityFor(consecutive),
      subject,
      // The failure count and the link to the newest run are the two things an
      // engineer reads, and both move with every failed run.
      restate: true,
    });
  } catch (error) {
    logger.error(
      { err: error, repo: key.repo, branch: key.branch, workflow: key.workflowName },
      'Deployment alert evaluation failed',
    );
  }
}
