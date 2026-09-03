import { CiProvider, DeploymentStatus } from '@prisma/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { ensureMonitoredRepository } from '../../src/modules/github/github.service';
import { disconnectDatabase, resetDatabase } from '../helpers/database';

/**
 * Bootstrapping the repository named by GITHUB_MONITORED_REPO.
 *
 * Without this step a correctly configured deployment still shows an empty
 * pipelines page until somebody remembers to POST a connection, which reads
 * exactly like a broken integration.
 *
 * GitHub is stubbed at `fetch` rather than at the client, so the payload shapes
 * here are the ones the REST API actually returns and the mapping is exercised
 * end to end. `vi.hoisted` supplies the credentials before the environment is
 * frozen at import time.
 */

const REPO = vi.hoisted(() => {
  const repo = 'pulsara-test/monitored';
  process.env.GITHUB_TOKEN = 'ghp_a_personal_access_token';
  process.env.GITHUB_MONITORED_REPO = repo;
  delete process.env.GITHUB_APP_ID;
  delete process.env.GITHUB_APP_PRIVATE_KEY;
  return repo;
});

const [OWNER, NAME] = REPO.split('/') as [string, string];

const RUN = {
  id: 987654321,
  name: 'CI',
  head_branch: 'main',
  head_sha: 'c'.repeat(40),
  event: 'push',
  status: 'completed',
  conclusion: 'success',
  html_url: `https://github.com/${REPO}/actions/runs/987654321`,
  created_at: '2026-02-01T09:59:00Z',
  updated_at: '2026-02-01T10:04:00Z',
  run_started_at: '2026-02-01T10:00:00Z',
  actor: { login: 'octocat', avatar_url: 'https://avatars.example/octocat.png' },
  head_commit: { message: 'Ship the thing\n\nlong body' },
  repository: { full_name: REPO },
};

const JOB = {
  id: 555,
  run_id: RUN.id,
  name: 'build',
  status: 'completed',
  conclusion: 'success',
  started_at: '2026-02-01T10:00:10Z',
  completed_at: '2026-02-01T10:02:30Z',
  html_url: `https://github.com/${REPO}/actions/runs/987654321/job/555`,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', etag: 'W/"abc123"' },
  });
}

/** Routes a GitHub REST path to a canned response, as the real API would. */
function stubGitHub(overrides: { repo?: () => Response; runs?: () => Response } = {}) {
  const calls: string[] = [];

  const mock = vi.fn((url: string | URL, _init?: RequestInit) => {
    const path = String(url);
    calls.push(path);

    if (path.endsWith(`/repos/${REPO}`)) {
      return Promise.resolve(
        overrides.repo?.() ?? json({ id: 42, full_name: REPO, default_branch: 'main' }),
      );
    }
    if (path.includes('/actions/runs?')) {
      return Promise.resolve(overrides.runs?.() ?? json({ workflow_runs: [RUN] }));
    }
    if (path.includes('/jobs')) {
      return Promise.resolve(json({ jobs: [JOB] }));
    }
    return Promise.resolve(json({ message: 'unexpected path' }, 404));
  });

  vi.stubGlobal('fetch', mock);
  return { mock, calls };
}

beforeEach(resetDatabase);

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(disconnectDatabase);

describe('ensureMonitoredRepository', () => {
  it('connects the configured repository and backfills its runs', async () => {
    stubGitHub();

    await ensureMonitoredRepository();

    const connection = await prisma.repoConnection.findUniqueOrThrow({
      where: { provider_owner_name: { provider: CiProvider.GITHUB, owner: OWNER, name: NAME } },
    });
    expect(connection.defaultBranch).toBe('main');
    // Recorded because it survives a rename, while owner/name does not.
    expect(connection.externalId).toBe('42');
    expect(connection.lastSyncError).toBeNull();

    const deployment = await prisma.deployment.findFirstOrThrow();
    expect(deployment.externalId).toBe(String(RUN.id));
    expect(deployment.repo).toBe(REPO);
    expect(deployment.branch).toBe('main');
    expect(deployment.commitSha).toBe(RUN.head_sha);
    expect(deployment.workflowName).toBe('CI');
    expect(deployment.status).toBe(DeploymentStatus.SUCCESS);
    // 10:00:00 to 10:04:00 — the queue time before the run started is not part
    // of its duration.
    expect(deployment.duration).toBe(240);
    // Only the subject line; a commit body is unbounded and the column is not.
    expect(deployment.commitMessage).toBe('Ship the thing');
    expect(deployment.repoConnectionId).toBe(connection.id);
  });

  it('backfills the run stages too', async () => {
    stubGitHub();

    await ensureMonitoredRepository();

    const stage = await prisma.stage.findFirstOrThrow();
    expect(stage.externalId).toBe(String(JOB.id));
    expect(stage.name).toBe('build');
    expect(stage.status).toBe(DeploymentStatus.SUCCESS);
    expect(stage.duration).toBe(140);
  });

  it('does nothing on a second boot', async () => {
    /**
     * Re-verifying and re-backfilling every start would spend rate limit
     * re-reading runs already stored, and would quietly resurrect a repository
     * an operator had deliberately disconnected.
     */
    stubGitHub();
    await ensureMonitoredRepository();
    vi.unstubAllGlobals();

    const second = stubGitHub();
    await ensureMonitoredRepository();

    expect(second.mock).not.toHaveBeenCalled();
    expect(await prisma.repoConnection.count()).toBe(1);
    expect(await prisma.deployment.count()).toBe(1);
  });

  it('starts the API anyway when GitHub is unreachable', async () => {
    /**
     * Every other part of the product works without CI data. Failing startup
     * because a third party is down would turn somebody else's outage into
     * this service's outage.
     */
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('network down'))),
    );

    await expect(ensureMonitoredRepository()).resolves.toBeUndefined();
    expect(await prisma.repoConnection.count()).toBe(0);
  });

  it('starts the API anyway when the repository cannot be read', async () => {
    // A revoked token or a renamed repository, which is the same 404 to us.
    stubGitHub({ repo: () => json({ message: 'Not Found' }, 404) });

    await expect(ensureMonitoredRepository()).resolves.toBeUndefined();
    expect(await prisma.repoConnection.count()).toBe(0);
  });

  it('records a sync failure on the connection rather than only logging it', async () => {
    // The UI says "this repository could not be synced, here is why" instead of
    // showing an empty list that looks like a quiet repository.
    stubGitHub({ runs: () => json({ message: 'Bad credentials' }, 401) });

    await ensureMonitoredRepository();

    const connection = await prisma.repoConnection.findFirstOrThrow();
    expect(connection.lastSyncError).toContain('401');
    expect(await prisma.deployment.count()).toBe(0);
  });

  it('sends the configured credential', async () => {
    const { mock } = stubGitHub();

    await ensureMonitoredRepository();

    const [, init] = mock.mock.calls[0] ?? [];
    const headers = init?.headers as Headers;
    expect(headers.get('authorization')).toBe('Bearer ghp_a_personal_access_token');
    // GitHub requires an explicit API version.
    expect(headers.get('x-github-api-version')).toBeTruthy();
  });
});
