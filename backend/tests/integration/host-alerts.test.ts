import { IncidentEventKind, IncidentSource, IncidentStatus, Severity } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/db/prisma';
import {
  evaluateHostSample,
  resetHostAlertState,
} from '../../src/modules/incidents/host-alert-engine';
import type { HostSnapshot } from '../../src/modules/telemetry/host-collector';
import { disconnectDatabase, resetDatabase } from '../helpers/database';

/**
 * Threshold alerting on host resources.
 *
 * The thresholds are pinned in tests/test-env.ts: CPU and memory at 90%, disk
 * at 85%, CRITICAL at 97%, three consecutive samples to open and five to
 * resolve.
 *
 * These run against the real database rather than a mocked client because the
 * property that matters — one open incident per condition, however many samples
 * arrive — is enforced by a partial unique index, not by the code above it.
 */

const HOST = 'test-host';

function snapshot(overrides: Partial<HostSnapshot> = {}): HostSnapshot {
  return {
    host: HOST,
    cpu: 10,
    memory: 20,
    disk: 30,
    networkRx: 1000,
    networkTx: 500,
    load1m: 0.2,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

/** Feeds the engine the same sample `times` times, as the collector would. */
async function sustain(sample: HostSnapshot, times: number): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await evaluateHostSample(sample);
  }
}

beforeEach(async () => {
  await resetDatabase();
  resetHostAlertState();
});

afterAll(disconnectDatabase);

describe('sustained breach', () => {
  it('opens nothing while the breach is shorter than the threshold', async () => {
    // A single sample above the line is a garbage collection pause or a backup
    // starting. Paging on it is how an alerting system gets muted.
    await sustain(snapshot({ cpu: 95 }), 2);
    expect(await prisma.incident.count()).toBe(0);
  });

  it('opens one incident once the breach is sustained', async () => {
    await sustain(snapshot({ cpu: 95 }), 3);

    const incident = await prisma.incident.findFirstOrThrow();
    expect(incident.title).toBe(`CPU pressure on ${HOST}`);
    expect(incident.severity).toBe(Severity.HIGH);
    expect(incident.source).toBe(IncidentSource.AUTOMATED);
    expect(incident.isOpen).toBe(true);
    expect(incident.description).toContain('95.0%');
    expect(incident.description).toContain('90%');
  });

  it('does not open a second incident however long the breach continues', async () => {
    await sustain(snapshot({ cpu: 95 }), 30);
    expect(await prisma.incident.count()).toBe(1);
  });

  it('records the opening on the timeline', async () => {
    await sustain(snapshot({ cpu: 95 }), 3);

    const events = await prisma.incidentEvent.findMany();
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe(IncidentEventKind.OPENED);
  });

  it('watches each resource independently', async () => {
    await sustain(snapshot({ cpu: 95, memory: 95, disk: 90 }), 3);

    const titles = (await prisma.incident.findMany({ orderBy: { title: 'asc' } })).map(
      (incident) => incident.title,
    );
    expect(titles).toEqual([
      `CPU pressure on ${HOST}`,
      `Disk pressure on ${HOST}`,
      `Memory pressure on ${HOST}`,
    ]);
  });

  it('applies each resource its own threshold', async () => {
    // 88% is over the disk threshold of 85 but under the CPU threshold of 90.
    await sustain(snapshot({ cpu: 88, disk: 88 }), 3);

    const incidents = await prisma.incident.findMany();
    expect(incidents).toHaveLength(1);
    expect(incidents[0]?.title).toBe(`Disk pressure on ${HOST}`);
  });

  it('treats an unmeasured resource as unmeasured, not as zero', async () => {
    /**
     * A missing disk reading rendered as 0% would silently satisfy every
     * recovery check and close a real incident.
     */
    await sustain(snapshot({ disk: 95 }), 3);
    expect(await prisma.incident.count()).toBe(1);

    await sustain(snapshot({ disk: null }), 10);

    const incident = await prisma.incident.findFirstOrThrow();
    expect(incident.isOpen).toBe(true);
  });
});

describe('severity', () => {
  it('escalates an open incident when the breach worsens', async () => {
    await sustain(snapshot({ cpu: 92 }), 3);
    expect((await prisma.incident.findFirstOrThrow()).severity).toBe(Severity.HIGH);

    await sustain(snapshot({ cpu: 99 }), 3);

    const incident = await prisma.incident.findFirstOrThrow();
    expect(incident.severity).toBe(Severity.CRITICAL);
    // Still one incident: escalation, not a second occurrence.
    expect(await prisma.incident.count()).toBe(1);

    const kinds = (await prisma.incidentEvent.findMany({ orderBy: { id: 'asc' } })).map(
      (event) => event.kind,
    );
    expect(kinds).toEqual([IncidentEventKind.OPENED, IncidentEventKind.SEVERITY_CHANGED]);
  });

  it('never de-escalates while the incident is open', async () => {
    /**
     * Dropping a CRITICAL back to HIGH because one sample came in lower would
     * take it below whatever threshold a human is watching, mid-event.
     */
    await sustain(snapshot({ cpu: 99 }), 3);
    expect((await prisma.incident.findFirstOrThrow()).severity).toBe(Severity.CRITICAL);

    await sustain(snapshot({ cpu: 91 }), 3);
    expect((await prisma.incident.findFirstOrThrow()).severity).toBe(Severity.CRITICAL);
  });
});

describe('recovery', () => {
  it('does not resolve on the first sample back under the line', async () => {
    await sustain(snapshot({ cpu: 95 }), 3);
    await sustain(snapshot({ cpu: 10 }), 4);

    expect((await prisma.incident.findFirstOrThrow()).isOpen).toBe(true);
  });

  it('resolves once recovery is sustained', async () => {
    await sustain(snapshot({ cpu: 95 }), 3);
    await sustain(snapshot({ cpu: 10 }), 5);

    const incident = await prisma.incident.findFirstOrThrow();
    expect(incident.isOpen).toBe(false);
    expect(incident.status).toBe(IncidentStatus.RESOLVED);
    expect(incident.resolvedAt).not.toBeNull();

    const resolved = await prisma.incidentEvent.findFirst({
      where: { kind: IncidentEventKind.RESOLVED },
    });
    expect(resolved?.message).toContain('below the 90% threshold');
  });

  it('resets the breach streak, so a flap does not accumulate towards opening', async () => {
    await sustain(snapshot({ cpu: 95 }), 2);
    await sustain(snapshot({ cpu: 10 }), 1);
    await sustain(snapshot({ cpu: 95 }), 2);

    expect(await prisma.incident.count()).toBe(0);
  });

  it('opens a fresh incident if the condition returns after resolving', async () => {
    await sustain(snapshot({ cpu: 95 }), 3);
    await sustain(snapshot({ cpu: 10 }), 5);
    await sustain(snapshot({ cpu: 95 }), 3);

    const incidents = await prisma.incident.findMany({ orderBy: { createdAt: 'asc' } });
    expect(incidents).toHaveLength(2);
    expect(incidents[0]?.isOpen).toBe(false);
    expect(incidents[1]?.isOpen).toBe(true);
  });

  it('leaves a manually raised incident for a human', async () => {
    /**
     * A person who opened an incident by hand may be tracking something the
     * sampler cannot see. Closing their investigation because CPU came back
     * under 90% would be worse than leaving it open.
     */
    await sustain(snapshot({ cpu: 95 }), 3);

    await prisma.incident.updateMany({ data: { source: IncidentSource.MANUAL } });
    await sustain(snapshot({ cpu: 10 }), 5);

    expect((await prisma.incident.findFirstOrThrow()).isOpen).toBe(true);
  });

  it('keys incidents by host, so one machine recovering does not clear another', async () => {
    await sustain(snapshot({ cpu: 95 }), 3);
    await sustain(snapshot({ host: 'other-host', cpu: 95 }), 3);
    expect(await prisma.incident.count()).toBe(2);

    await sustain(snapshot({ cpu: 10 }), 5);

    const open = await prisma.incident.findMany({ where: { isOpen: true } });
    expect(open).toHaveLength(1);
    expect(open[0]?.title).toBe('CPU pressure on other-host');
  });
});
