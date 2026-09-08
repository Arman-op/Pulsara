import { CiProvider, DeploymentStatus, IncidentSource, Severity } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { evaluateDeploymentHealth } from '../../src/modules/incidents/deployment-alert-engine';
import { disconnectDatabase, resetDatabase } from '../helpers/database';

/**
 * Alerting from delivery failures.
 *
 * The engine decides from the newest finished run rather than from the run that
 * just arrived, which is what makes backfill safe, out-of-order webhook
 * delivery safe, and the whole thing idempotent. Most of what is asserted here
 * is that property in its various disguises.
 *
 * `DEPLOYMENT_FAILURE_ESCALATION_RUNS` is 3 in tests/test-env.ts.
 */

const REPO = 'pulsara/pulsara';
const WORKFLOW = 'CI';
const DEFAULT_BRANCH = 'main';

const KEY = { repo: REPO, workflowName: WORKFLOW, branch: DEFAULT_BRANCH };

let sequence = 0;

/** Records a finished run, newest last, as the mirror would. */
async function run(
  status: DeploymentStatus,
  overrides: { branch?: string; workflowName?: string | null } = {},
): Promise<void> {
  sequence += 1;
  await prisma.deployment.create({
    data: {
      provider: CiProvider.GITHUB,
      externalId: String(sequence),
      externalUrl: `https://github.com/${REPO}/actions/runs/${sequence}`,
      repo: REPO,
      branch: overrides.branch ?? DEFAULT_BRANCH,
      workflowName: overrides.workflowName === undefined ? WORKFLOW : overrides.workflowName,
      event: 'push',
      commitSha: 'a'.repeat(40),
      status,
      // Explicit and increasing, so "newest" is deterministic rather than
      // dependent on how fast the test inserts rows.
      createdAt: new Date(Date.now() + sequence * 1000),
    },
  });
}

async function connectRepository(defaultBranch: string | null = DEFAULT_BRANCH): Promise<void> {
  const [owner, name] = REPO.split('/') as [string, string];
  await prisma.repoConnection.create({
    data: { provider: CiProvider.GITHUB, owner, name, defaultBranch },
  });
}

const openIncidents = () => prisma.incident.findMany({ where: { isOpen: true } });

beforeEach(async () => {
  await resetDatabase();
  sequence = 0;
});

afterAll(disconnectDatabase);

describe('a failing default branch', () => {
  it('opens an incident', async () => {
    await connectRepository();
    await run(DeploymentStatus.FAILED);

    await evaluateDeploymentHealth(KEY);

    const incident = await prisma.incident.findFirstOrThrow();
    expect(incident.title).toBe('CI failing on main');
    expect(incident.severity).toBe(Severity.HIGH);
    expect(incident.source).toBe(IncidentSource.AUTOMATED);
    expect(incident.description).toContain('1 run');
    // One click from the incident to the logs that explain it.
    expect(incident.description).toContain('https://github.com/pulsara/pulsara/actions/runs/1');
  });

  it('escalates once it has been failing for several runs', async () => {
    await connectRepository();

    await run(DeploymentStatus.FAILED);
    await evaluateDeploymentHealth(KEY);
    expect((await prisma.incident.findFirstOrThrow()).severity).toBe(Severity.HIGH);

    await run(DeploymentStatus.FAILED);
    await run(DeploymentStatus.FAILED);
    await evaluateDeploymentHealth(KEY);

    const incident = await prisma.incident.findFirstOrThrow();
    expect(incident.severity).toBe(Severity.CRITICAL);
    expect(incident.description).toContain('3 consecutive runs');
    // Escalation, not a second incident.
    expect(await prisma.incident.count()).toBe(1);
  });

  it('counts only the failures since the last success', async () => {
    // Otherwise a repository with a long history escalates to CRITICAL the
    // moment it goes red once.
    await connectRepository();

    await run(DeploymentStatus.FAILED);
    await run(DeploymentStatus.FAILED);
    await run(DeploymentStatus.SUCCESS);
    await run(DeploymentStatus.FAILED);

    await evaluateDeploymentHealth(KEY);

    const incident = await prisma.incident.findFirstOrThrow();
    expect(incident.severity).toBe(Severity.HIGH);
    expect(incident.description).toContain('1 run');
  });

  it('keeps the failure count and the newest run link current', async () => {
    /**
     * Found by delivering real webhooks rather than by reasoning: the row was
     * only restated when severity rose, so an incident open since the first
     * failure went on saying "for 1 run" and linking that first run while the
     * build had been red six times. That is the field an engineer reads, and
     * the newest run is the one they want to open.
     *
     * The timeline is deliberately not appended to — a build failing again is
     * the same incident, and an entry per run would bury the transitions that
     * mean something.
     */
    await connectRepository();

    await run(DeploymentStatus.FAILED);
    await evaluateDeploymentHealth(KEY);
    expect((await prisma.incident.findFirstOrThrow()).description).toContain('for 1 run');

    await run(DeploymentStatus.FAILED);
    await evaluateDeploymentHealth(KEY);

    const incident = await prisma.incident.findFirstOrThrow();
    // Severity is unchanged: two failures is still below the escalation mark.
    expect(incident.severity).toBe(Severity.HIGH);
    expect(incident.description).toContain('for 2 consecutive runs');
    expect(incident.description).toContain('/runs/2');
    expect(await prisma.incidentEvent.count()).toBe(1);
  });

  it('is idempotent, so a re-run of the same broken build changes nothing', async () => {
    await connectRepository();
    await run(DeploymentStatus.FAILED);

    await evaluateDeploymentHealth(KEY);
    await evaluateDeploymentHealth(KEY);
    await evaluateDeploymentHealth(KEY);

    expect(await prisma.incident.count()).toBe(1);
    expect(await prisma.incidentEvent.count()).toBe(1);
  });
});

describe('recovery', () => {
  it('resolves when the workflow passes again', async () => {
    await connectRepository();
    await run(DeploymentStatus.FAILED);
    await evaluateDeploymentHealth(KEY);

    await run(DeploymentStatus.SUCCESS);
    await evaluateDeploymentHealth(KEY);

    const incident = await prisma.incident.findFirstOrThrow();
    expect(incident.isOpen).toBe(false);
    expect(incident.resolvedAt).not.toBeNull();
  });

  it('ignores a cancelled run rather than reading it either way', async () => {
    /**
     * A cancelled run is usually somebody superseding their own push. It is
     * neither a failure nor evidence of recovery, so an open incident stays
     * open and a healthy branch stays quiet.
     */
    await connectRepository();
    await run(DeploymentStatus.FAILED);
    await evaluateDeploymentHealth(KEY);

    await run(DeploymentStatus.CANCELED);
    await evaluateDeploymentHealth(KEY);

    expect((await prisma.incident.findFirstOrThrow()).isOpen).toBe(true);
  });

  it('does not treat a queued or running build as recovery', async () => {
    // Otherwise pushing a retry clears the incident before the retry has said
    // anything at all.
    await connectRepository();
    await run(DeploymentStatus.FAILED);
    await evaluateDeploymentHealth(KEY);

    await run(DeploymentStatus.RUNNING);
    await evaluateDeploymentHealth(KEY);

    expect((await prisma.incident.findFirstOrThrow()).isOpen).toBe(true);
  });
});

describe('what does not alert', () => {
  it('stays quiet for a feature branch', async () => {
    /**
     * A failing build on a feature branch is a developer mid-work. Opening an
     * incident for every failed pull-request run would bury the outages this
     * feed exists to surface.
     */
    await connectRepository();
    await run(DeploymentStatus.FAILED, { branch: 'feature/thing' });

    await evaluateDeploymentHealth({ ...KEY, branch: 'feature/thing' });

    expect(await prisma.incident.count()).toBe(0);
  });

  it('stays quiet when the default branch is unknown', async () => {
    // Guessing `main` would be wrong for every repository still on `master`.
    await connectRepository(null);
    await run(DeploymentStatus.FAILED);

    await evaluateDeploymentHealth(KEY);

    expect(await prisma.incident.count()).toBe(0);
  });

  it('stays quiet for a repository nobody connected', async () => {
    await run(DeploymentStatus.FAILED);
    await evaluateDeploymentHealth(KEY);
    expect(await prisma.incident.count()).toBe(0);
  });

  it('keeps workflows in the same repository apart', async () => {
    await connectRepository();
    await run(DeploymentStatus.FAILED, { workflowName: 'CI' });
    await run(DeploymentStatus.FAILED, { workflowName: 'Release' });

    await evaluateDeploymentHealth({ ...KEY, workflowName: 'CI' });
    await evaluateDeploymentHealth({ ...KEY, workflowName: 'Release' });

    expect(await openIncidents()).toHaveLength(2);

    // Fixing one must not close the other.
    await run(DeploymentStatus.SUCCESS, { workflowName: 'CI' });
    await evaluateDeploymentHealth({ ...KEY, workflowName: 'CI' });

    const stillOpen = await openIncidents();
    expect(stillOpen).toHaveLength(1);
    expect(stillOpen[0]?.title).toBe('Release failing on main');
  });
});

describe('backfill', () => {
  it('does not open an incident for a failure that was already fixed', async () => {
    /**
     * The reason the engine reads stored state rather than reacting to each
     * arriving run: backfilling thirty runs would otherwise open an incident
     * for every red build in the repository's recent history, including the
     * ones somebody fixed last week.
     */
    await connectRepository();

    await run(DeploymentStatus.FAILED);
    await run(DeploymentStatus.FAILED);
    await run(DeploymentStatus.SUCCESS);

    await evaluateDeploymentHealth(KEY);

    expect(await prisma.incident.count()).toBe(0);
  });

  it('opens one when the newest run is the failing one', async () => {
    await connectRepository();

    await run(DeploymentStatus.SUCCESS);
    await run(DeploymentStatus.FAILED);

    await evaluateDeploymentHealth(KEY);

    expect(await prisma.incident.count()).toBe(1);
  });
});
