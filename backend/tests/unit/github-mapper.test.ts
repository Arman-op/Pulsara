import { DeploymentStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import type { GitHubWorkflowJob, GitHubWorkflowRun } from '../../src/modules/github/github.client';
import {
  mapWorkflowJob,
  mapWorkflowRun,
  toDeploymentStatus,
} from '../../src/modules/github/github.mapper';

/**
 * GitHub splits a run's outcome across two fields — `status` for progress and
 * `conclusion` for result, null until the run finishes — and collapsing them
 * incorrectly is how a dashboard shows a failed deployment as green. The
 * mapping is therefore asserted case by case rather than spot-checked.
 */

const REPO = 'pulsara/pulsara';

function run(overrides: Partial<GitHubWorkflowRun> = {}): GitHubWorkflowRun {
  return {
    id: 42,
    name: 'CI',
    head_branch: 'main',
    head_sha: 'a'.repeat(40),
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    html_url: 'https://github.com/pulsara/pulsara/actions/runs/42',
    created_at: '2026-01-01T10:00:00Z',
    updated_at: '2026-01-01T10:05:00Z',
    run_started_at: '2026-01-01T10:00:30Z',
    actor: { login: 'octocat', avatar_url: 'https://avatars.example/octocat.png' },
    head_commit: { message: 'Fix the thing\n\nWith a long body that must not be stored.' },
    repository: { full_name: REPO },
    ...overrides,
  };
}

describe('toDeploymentStatus', () => {
  it('maps in-flight runs from status alone', () => {
    expect(toDeploymentStatus('in_progress', null)).toBe(DeploymentStatus.RUNNING);
    expect(toDeploymentStatus('queued', null)).toBe(DeploymentStatus.PENDING);
    expect(toDeploymentStatus('waiting', null)).toBe(DeploymentStatus.PENDING);
    expect(toDeploymentStatus('requested', null)).toBe(DeploymentStatus.PENDING);
  });

  it('maps completed runs from conclusion', () => {
    expect(toDeploymentStatus('completed', 'success')).toBe(DeploymentStatus.SUCCESS);
    expect(toDeploymentStatus('completed', 'failure')).toBe(DeploymentStatus.FAILED);
    expect(toDeploymentStatus('completed', 'timed_out')).toBe(DeploymentStatus.FAILED);
    expect(toDeploymentStatus('completed', 'cancelled')).toBe(DeploymentStatus.CANCELED);
    expect(toDeploymentStatus('completed', 'skipped')).toBe(DeploymentStatus.CANCELED);
    expect(toDeploymentStatus('completed', 'stale')).toBe(DeploymentStatus.CANCELED);
  });

  it('does not report a run that finished without doing its job as successful', () => {
    // `action_required` and `neutral` are completed-but-unsuccessful. Treating
    // either as SUCCESS is exactly what makes a dashboard untrustworthy.
    expect(toDeploymentStatus('completed', 'action_required')).toBe(DeploymentStatus.FAILED);
    expect(toDeploymentStatus('completed', 'neutral')).toBe(DeploymentStatus.FAILED);
  });

  it('fails closed on values GitHub has not documented yet', () => {
    expect(toDeploymentStatus('completed', 'something_new')).toBe(DeploymentStatus.FAILED);
    expect(toDeploymentStatus('completed', null)).toBe(DeploymentStatus.FAILED);
    expect(toDeploymentStatus('some_new_status', null)).toBe(DeploymentStatus.PENDING);
  });
});

describe('mapWorkflowRun', () => {
  it('records only the commit subject line', () => {
    expect(mapWorkflowRun(run(), REPO).commitMessage).toBe('Fix the thing');
  });

  it('truncates a subject longer than the column', () => {
    const mapped = mapWorkflowRun(run({ head_commit: { message: 'x'.repeat(900) } }), REPO);
    expect(mapped.commitMessage).toHaveLength(500);
  });

  it('names a branchless run rather than storing null', () => {
    // Tag pushes and merge-queue runs have no head branch.
    expect(mapWorkflowRun(run({ head_branch: null }), REPO).branch).toBe('(detached)');
  });

  it('leaves an unfinished run without a completion time or duration', () => {
    // `updated_at` moves on every state change, so treating it as the
    // completion time would show a running deployment as already finished.
    const mapped = mapWorkflowRun(run({ status: 'in_progress', conclusion: null }), REPO);
    expect(mapped.status).toBe(DeploymentStatus.RUNNING);
    expect(mapped.completedAt).toBeNull();
    expect(mapped.duration).toBeNull();
  });

  it('computes duration in whole seconds from the run start', () => {
    // run_started_at (10:00:30) to updated_at (10:05:00) is 270 seconds; the
    // queue time before it is not part of the run's duration.
    expect(mapWorkflowRun(run(), REPO).duration).toBe(270);
  });

  it('falls back to created_at when the run never reported a start', () => {
    expect(mapWorkflowRun(run({ run_started_at: null }), REPO).duration).toBe(300);
  });

  it('reports no duration rather than a negative one when clocks disagree', () => {
    const skewed = run({ run_started_at: '2026-01-01T10:06:00Z' });
    expect(mapWorkflowRun(skewed, REPO).duration).toBeNull();
  });

  it('falls back to the requested repository when the payload omits one', () => {
    expect(mapWorkflowRun(run({ repository: undefined }), REPO).repo).toBe(REPO);
  });

  it('tolerates a run with no actor', () => {
    const mapped = mapWorkflowRun(run({ actor: null, head_commit: null }), REPO);
    expect(mapped.actorLogin).toBeNull();
    expect(mapped.actorAvatarUrl).toBeNull();
    expect(mapped.commitMessage).toBeNull();
  });
});

describe('mapWorkflowJob', () => {
  const job: GitHubWorkflowJob = {
    id: 7,
    run_id: 42,
    name: 'build',
    status: 'completed',
    conclusion: 'failure',
    started_at: '2026-01-01T10:01:00Z',
    completed_at: '2026-01-01T10:01:45Z',
    html_url: 'https://github.com/pulsara/pulsara/actions/runs/42/job/7',
  };

  it('maps a job the same way it maps a run', () => {
    const mapped = mapWorkflowJob(job);
    expect(mapped.externalId).toBe('7');
    expect(mapped.status).toBe(DeploymentStatus.FAILED);
    expect(mapped.duration).toBe(45);
  });

  it('leaves a running job without a duration', () => {
    const mapped = mapWorkflowJob({
      ...job,
      status: 'in_progress',
      conclusion: null,
      completed_at: null,
    });
    expect(mapped.status).toBe(DeploymentStatus.RUNNING);
    expect(mapped.duration).toBeNull();
  });
});
