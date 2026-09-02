import { DeploymentStatus } from '@prisma/client';
import type { GitHubWorkflowJob, GitHubWorkflowRun } from './github.client';

/**
 * Translation between GitHub's vocabulary and Pulsara's.
 *
 * GitHub splits the outcome of a run across two fields: `status` describes
 * progress (queued, in_progress, completed) and `conclusion` describes the
 * result, and is null until the run finishes. Collapsing them correctly is the
 * whole job of this module, and getting it wrong is how a dashboard ends up
 * showing a failed deployment as green.
 */

const MS_PER_SECOND = 1_000;
const MAX_COMMIT_MESSAGE_LENGTH = 500;

/** GitHub's `status` values. */
const RunStatus = {
  Queued: 'queued',
  InProgress: 'in_progress',
  Completed: 'completed',
  Waiting: 'waiting',
  Requested: 'requested',
  Pending: 'pending',
} as const;

/** GitHub's `conclusion` values. */
const RunConclusion = {
  Success: 'success',
  Failure: 'failure',
  Cancelled: 'cancelled',
  Skipped: 'skipped',
  TimedOut: 'timed_out',
  ActionRequired: 'action_required',
  Neutral: 'neutral',
  Stale: 'stale',
} as const;

export function toDeploymentStatus(
  status: string | null,
  conclusion: string | null,
): DeploymentStatus {
  // While a run is in flight, `conclusion` is null and only `status` is useful.
  if (status !== RunStatus.Completed) {
    switch (status) {
      case RunStatus.InProgress:
        return DeploymentStatus.RUNNING;
      case RunStatus.Queued:
      case RunStatus.Waiting:
      case RunStatus.Requested:
      case RunStatus.Pending:
        return DeploymentStatus.PENDING;
      default:
        return DeploymentStatus.PENDING;
    }
  }

  switch (conclusion) {
    case RunConclusion.Success:
      return DeploymentStatus.SUCCESS;
    case RunConclusion.Cancelled:
    case RunConclusion.Skipped:
    case RunConclusion.Stale:
      return DeploymentStatus.CANCELED;
    case RunConclusion.Failure:
    case RunConclusion.TimedOut:
      return DeploymentStatus.FAILED;
    case RunConclusion.ActionRequired:
    case RunConclusion.Neutral:
      /**
       * `action_required` and `neutral` are completed-but-unsuccessful. They
       * are reported as FAILED rather than SUCCESS: a run that finished without
       * doing its job is not a green deployment, and defaulting to success here
       * is exactly the bug that makes a dashboard untrustworthy.
       */
      return DeploymentStatus.FAILED;
    default:
      return DeploymentStatus.FAILED;
  }
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Duration in whole seconds, or null.
 *
 * Null while the run is unfinished, and null rather than a negative number if
 * the timestamps disagree — which happens with clock skew across GitHub's
 * runners, and would otherwise render as a deployment that took minus four
 * seconds.
 */
function durationSeconds(startedAt: Date | null, completedAt: Date | null): number | null {
  if (!startedAt || !completedAt) return null;
  const elapsed = completedAt.getTime() - startedAt.getTime();
  return elapsed >= 0 ? Math.round(elapsed / MS_PER_SECOND) : null;
}

export type MappedDeployment = {
  externalId: string;
  externalUrl: string;
  repo: string;
  branch: string;
  workflowName: string | null;
  event: string;
  status: DeploymentStatus;
  duration: number | null;
  commitSha: string;
  commitMessage: string | null;
  actorLogin: string | null;
  actorAvatarUrl: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
};

export function mapWorkflowRun(run: GitHubWorkflowRun, repoFullName: string): MappedDeployment {
  const status = toDeploymentStatus(run.status, run.conclusion);
  const startedAt = parseDate(run.run_started_at) ?? parseDate(run.created_at);
  // `updated_at` is the completion time only once the run has finished; while
  // it is still going, it merely marks the last state change.
  const completedAt =
    status === DeploymentStatus.RUNNING || status === DeploymentStatus.PENDING
      ? null
      : parseDate(run.updated_at);

  return {
    externalId: String(run.id),
    externalUrl: run.html_url,
    repo: run.repository?.full_name ?? repoFullName,
    // A run triggered by a tag or a merge queue can have no head branch.
    branch: run.head_branch ?? '(detached)',
    workflowName: run.name,
    event: run.event,
    status,
    duration: durationSeconds(startedAt, completedAt),
    commitSha: run.head_sha,
    // Only the subject line: a commit body can be arbitrarily long and the
    // column is bounded.
    commitMessage:
      run.head_commit?.message?.split('\n')[0]?.slice(0, MAX_COMMIT_MESSAGE_LENGTH) ?? null,
    actorLogin: run.actor?.login ?? null,
    actorAvatarUrl: run.actor?.avatar_url ?? null,
    startedAt,
    completedAt,
  };
}

export type MappedStage = {
  externalId: string;
  name: string;
  status: DeploymentStatus;
  duration: number | null;
  externalUrl: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
};

export function mapWorkflowJob(job: GitHubWorkflowJob): MappedStage {
  const startedAt = parseDate(job.started_at);
  const completedAt = parseDate(job.completed_at);

  return {
    externalId: String(job.id),
    name: job.name,
    status: toDeploymentStatus(job.status, job.conclusion),
    duration: durationSeconds(startedAt, completedAt),
    externalUrl: job.html_url,
    startedAt,
    completedAt,
  };
}
