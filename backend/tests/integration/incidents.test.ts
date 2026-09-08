import {
  AuditAction,
  IncidentEventKind,
  IncidentSource,
  IncidentStatus,
  Role,
  ServiceState,
  Severity,
} from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../../src/app';
import { prisma } from '../../src/db/prisma';
import { disconnectDatabase, resetDatabase } from '../helpers/database';
import { createUser, signIn, signedInAs, type Session } from '../helpers/factories';

/**
 * Manual incident management, and the accountability record behind it.
 *
 * Operators genuinely open incidents by hand — for something a probe cannot
 * see, or for a change with no signal attached — so this is a real feature
 * rather than the static list it replaces. What makes it real is that it is
 * backed by validation, authorisation, a timeline, and an audit row naming who
 * did what.
 */

let member: Session;

beforeEach(async () => {
  await resetDatabase();
  member = await signedInAs(Role.MEMBER);
});

afterAll(disconnectDatabase);

const as = (session: Session) => ({ Authorization: `Bearer ${session.accessToken}` });

/** Not async: the supertest chain itself is returned, so callers can `.expect`. */
function openIncident(session: Session, body: Record<string, unknown> = {}) {
  return request(app)
    .post('/api/incidents')
    .set(as(session))
    .send({ title: 'Database is slow', severity: Severity.HIGH, ...body });
}

describe('POST /api/incidents', () => {
  it('creates an incident a person raised', async () => {
    const response = await openIncident(member).expect(201);

    expect(response.body.data.title).toBe('Database is slow');
    expect(response.body.data.status).toBe(IncidentStatus.INVESTIGATING);
    // Distinguishable from an incident the alerting engine opened, because the
    // two mean different things when deciding what to do.
    expect(response.body.data.source).toBe(IncidentSource.MANUAL);
    expect(response.body.data.isOpen).toBe(true);
  });

  it('carries no dedupe key, so two for the same service are allowed', async () => {
    /**
     * Deduplication is for machine-detected conditions. Two people tracking two
     * different problems on one service is legitimate, and the partial unique
     * index would otherwise reject the second.
     */
    await openIncident(member).expect(201);
    await openIncident(member, { title: 'A different problem' }).expect(201);

    const incidents = await prisma.incident.findMany();
    expect(incidents).toHaveLength(2);
    expect(incidents.every((incident) => incident.dedupeKey === null)).toBe(true);
  });

  it('opens the timeline with who raised it', async () => {
    const response = await openIncident(member).expect(201);

    const event = await prisma.incidentEvent.findFirstOrThrow({
      where: { incidentId: response.body.data.id },
    });
    expect(event.kind).toBe(IncidentEventKind.OPENED);
    expect(event.actorId).toBe(member.user.id);
  });

  it('links a real service and rejects one that does not exist', async () => {
    const service = await prisma.service.create({
      data: { name: 'API', status: ServiceState.ONLINE, probeIntervalSeconds: 30 },
    });

    const linked = await openIncident(member, { serviceId: service.id }).expect(201);
    expect(linked.body.data.service.name).toBe('API');

    await openIncident(member, { serviceId: '11111111-2222-3333-4444-555555555555' }).expect(400);
  });

  it('validates the body rather than storing whatever arrives', async () => {
    await request(app).post('/api/incidents').set(as(member)).send({}).expect(422);
    await openIncident(member, { title: '' }).expect(422);
    await openIncident(member, { severity: 'CATASTROPHIC' }).expect(422);
    await openIncident(member, { title: 'x'.repeat(201) }).expect(422);
  });

  it('refuses a viewer, who may watch an outage but not file one', async () => {
    const viewer = await signedInAs(Role.VIEWER);
    await openIncident(viewer).expect(403);
    await request(app).post('/api/incidents').send({ title: 'x', severity: 'LOW' }).expect(401);
  });
});

describe('PATCH /api/incidents/:id', () => {
  it('records a status change on the timeline and closes the incident', async () => {
    const created = await openIncident(member).expect(201);

    const resolved = await request(app)
      .patch(`/api/incidents/${created.body.data.id}`)
      .set(as(member))
      .send({ status: IncidentStatus.RESOLVED })
      .expect(200);

    expect(resolved.body.data.status).toBe(IncidentStatus.RESOLVED);
    // `isOpen` is derived from status rather than accepted from the client, so
    // the flag the dedupe index depends on cannot disagree with what a user
    // sees.
    expect(resolved.body.data.isOpen).toBe(false);
    expect(resolved.body.data.resolvedAt).not.toBeNull();

    const kinds = (await prisma.incidentEvent.findMany({ orderBy: { id: 'asc' } })).map(
      (event) => event.kind,
    );
    expect(kinds).toEqual([IncidentEventKind.OPENED, IncidentEventKind.RESOLVED]);
  });

  it('reopens a resolved incident and says so', async () => {
    const created = await openIncident(member).expect(201);
    const id = created.body.data.id as string;

    await request(app)
      .patch(`/api/incidents/${id}`)
      .set(as(member))
      .send({ status: IncidentStatus.RESOLVED })
      .expect(200);

    const reopened = await request(app)
      .patch(`/api/incidents/${id}`)
      .set(as(member))
      .send({ status: IncidentStatus.INVESTIGATING })
      .expect(200);

    expect(reopened.body.data.isOpen).toBe(true);
    expect(reopened.body.data.resolvedAt).toBeNull();

    const event = await prisma.incidentEvent.findFirst({
      where: { kind: IncidentEventKind.REOPENED },
    });
    expect(event).not.toBeNull();
  });

  it('assigns and unassigns', async () => {
    const created = await openIncident(member).expect(201);
    const id = created.body.data.id as string;
    const other = await createUser({ role: Role.MEMBER, name: 'Ada' });

    const assigned = await request(app)
      .patch(`/api/incidents/${id}`)
      .set(as(member))
      .send({ assigneeId: other.id })
      .expect(200);
    expect(assigned.body.data.assignee.name).toBe('Ada');

    const cleared = await request(app)
      .patch(`/api/incidents/${id}`)
      .set(as(member))
      .send({ assigneeId: null })
      .expect(200);
    expect(cleared.body.data.assignee).toBeNull();
  });

  it('writes no timeline entry when nothing actually changed', async () => {
    // A PATCH that sets severity to what it already was is not an event.
    const created = await openIncident(member).expect(201);

    await request(app)
      .patch(`/api/incidents/${created.body.data.id}`)
      .set(as(member))
      .send({ severity: Severity.HIGH })
      .expect(200);

    expect(await prisma.incidentEvent.count()).toBe(1);
  });

  it('rejects an empty patch, an unknown incident and an unknown assignee', async () => {
    const created = await openIncident(member).expect(201);
    const id = created.body.data.id as string;

    await request(app).patch(`/api/incidents/${id}`).set(as(member)).send({}).expect(422);
    await request(app)
      .patch('/api/incidents/11111111-2222-3333-4444-555555555555')
      .set(as(member))
      .send({ severity: Severity.LOW })
      .expect(404);
    await request(app)
      .patch(`/api/incidents/${id}`)
      .set(as(member))
      .send({ assigneeId: '11111111-2222-3333-4444-555555555555' })
      .expect(400);
  });

  it('refuses a viewer, who cannot silently resolve an outage', async () => {
    const created = await openIncident(member).expect(201);
    const viewer = await signedInAs(Role.VIEWER);

    await request(app)
      .patch(`/api/incidents/${created.body.data.id}`)
      .set(as(viewer))
      .send({ status: IncidentStatus.RESOLVED })
      .expect(403);
  });
});

describe('the audit trail', () => {
  /** The trail is administrator-only, so it takes an admin to read it back. */
  async function auditRows(): Promise<{ action: string; metadata: unknown; userId: string }[]> {
    const admin = await signedInAs(Role.ADMIN);
    const response = await request(app).get('/api/users/audit/log').set(as(admin)).expect(200);
    return response.body.data as { action: string; metadata: unknown; userId: string }[];
  }

  it('records who opened an incident', async () => {
    await openIncident(member).expect(201);

    const created = (await auditRows()).find((row) => row.action === AuditAction.INCIDENT_CREATED);
    expect(created?.userId).toBe(member.user.id);
  });

  it('records each state transition with its before and after', async () => {
    /**
     * "Somebody edited this incident" is not accountability. "This person moved
     * it from CRITICAL to LOW" is, and it is the question a postmortem actually
     * asks.
     */
    const created = await openIncident(member, { severity: Severity.CRITICAL }).expect(201);

    await request(app)
      .patch(`/api/incidents/${created.body.data.id}`)
      .set(as(member))
      .send({ severity: Severity.LOW, status: IncidentStatus.MONITORING })
      .expect(200);

    const rows = await auditRows();

    const severity = rows.find((row) => row.action === AuditAction.INCIDENT_SEVERITY_CHANGED);
    expect(severity?.metadata).toEqual({ from: Severity.CRITICAL, to: Severity.LOW });

    const status = rows.find((row) => row.action === AuditAction.INCIDENT_STATUS_CHANGED);
    expect(status?.metadata).toEqual({
      from: IncidentStatus.INVESTIGATING,
      to: IncidentStatus.MONITORING,
    });
  });

  it('commits with the change, so an audited action either happened or did not', async () => {
    /**
     * Written inside the same transaction as the update. A rejected change must
     * leave no trace claiming it occurred, and a change that occurred must
     * leave one.
     */
    const created = await openIncident(member).expect(201);

    await request(app)
      .patch(`/api/incidents/${created.body.data.id}`)
      .set(as(member))
      .send({ assigneeId: '11111111-2222-3333-4444-555555555555' })
      .expect(400);

    const assignments = (await auditRows()).filter(
      (row) => row.action === AuditAction.INCIDENT_ASSIGNED,
    );
    expect(assignments).toHaveLength(0);
  });

  it('names the person, not the account that happens to be reading', async () => {
    const other = await signIn(await createUser({ role: Role.MEMBER, name: 'Grace' }));
    const created = await openIncident(member).expect(201);

    await request(app)
      .patch(`/api/incidents/${created.body.data.id}`)
      .set(as(other))
      .send({ status: IncidentStatus.IDENTIFIED })
      .expect(200);

    const status = (await auditRows()).find(
      (row) => row.action === AuditAction.INCIDENT_STATUS_CHANGED,
    );
    expect(status?.userId).toBe(other.user.id);
  });

  it('leaves machine-driven transitions to the timeline', async () => {
    /**
     * `AuditLog.userId` is not nullable, and deliberately so: the trail answers
     * "who did this", and an automated resolution has no who. The timeline
     * records those, which is why both exist.
     */
    await prisma.incident.create({
      data: {
        title: 'Opened by the alerting engine',
        severity: Severity.CRITICAL,
        source: IncidentSource.AUTOMATED,
        dedupeKey: 'service-availability:test',
        isOpen: true,
      },
    });

    expect(await prisma.auditLog.count()).toBe(0);
  });
});

describe('GET /api/incidents', () => {
  it('puts open incidents first regardless of age', async () => {
    // A three-day-old outage still matters more than something resolved an
    // hour ago.
    const older = await openIncident(member, { title: 'Older, still open' }).expect(201);
    const newer = await openIncident(member, { title: 'Newer, resolved' }).expect(201);

    await request(app)
      .patch(`/api/incidents/${newer.body.data.id}`)
      .set(as(member))
      .send({ status: IncidentStatus.RESOLVED })
      .expect(200);

    const listed = await request(app).get('/api/incidents').set(as(member)).expect(200);
    expect(listed.body.data[0].id).toBe(older.body.data.id);
  });

  it('filters to open incidents only when asked', async () => {
    const created = await openIncident(member).expect(201);
    await openIncident(member, { title: 'Second' }).expect(201);

    await request(app)
      .patch(`/api/incidents/${created.body.data.id}`)
      .set(as(member))
      .send({ status: IncidentStatus.RESOLVED })
      .expect(200);

    const open = await request(app).get('/api/incidents?isOpen=true').set(as(member)).expect(200);
    expect(open.body.data).toHaveLength(1);
    expect(open.body.meta.total).toBe(1);
  });

  it('is readable by a viewer', async () => {
    const viewer = await signedInAs(Role.VIEWER);
    await request(app).get('/api/incidents').set(as(viewer)).expect(200);
  });
});
