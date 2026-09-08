import {
  AuditAction,
  IncidentEventKind,
  IncidentSource,
  IncidentStatus,
  type Prisma,
} from '@prisma/client';
import type { Request, Response } from 'express';
import { prisma } from '../../db/prisma';
import { recordAuditIn } from '../../lib/audit';
import { BadRequestError, NotFoundError } from '../../lib/errors';
import { pageMeta, sendSuccess } from '../../lib/http';
import { parseBody, parseParams, parseQuery, uuidParamSchema } from '../../lib/validation';
import { requireUser } from '../../middleware/auth';
import {
  addCommentSchema,
  createIncidentSchema,
  listIncidentsQuerySchema,
  updateIncidentSchema,
} from './incidents.schemas';

/**
 * Incident management.
 *
 * The assignee is always projected down to the fields the UI renders. Selecting
 * the whole User row would leave `passwordHash` one careless `include` away
 * from the wire.
 */
const ASSIGNEE_FIELDS = {
  select: { id: true, name: true, email: true, avatarUrl: true },
} as const;

const SERVICE_FIELDS = {
  select: { id: true, name: true, status: true },
} as const;

export async function listIncidents(req: Request, res: Response): Promise<void> {
  const { limit, offset, status, severity, serviceId, isOpen } = parseQuery(
    req,
    listIncidentsQuerySchema,
  );

  const where: Prisma.IncidentWhereInput = {
    ...(status ? { status } : {}),
    ...(severity ? { severity } : {}),
    ...(serviceId ? { serviceId } : {}),
    ...(isOpen === undefined ? {} : { isOpen }),
  };

  const [incidents, total] = await prisma.$transaction([
    prisma.incident.findMany({
      where,
      take: limit,
      skip: offset,
      // Newest first, but open incidents first regardless of age: a
      // three-day-old outage still matters more than a resolved one from an
      // hour ago.
      orderBy: [{ isOpen: 'desc' }, { createdAt: 'desc' }],
      include: { service: SERVICE_FIELDS, assignee: ASSIGNEE_FIELDS },
    }),
    prisma.incident.count({ where }),
  ]);

  sendSuccess(res, incidents, pageMeta(total, limit, offset));
}

/** One incident with its full timeline. */
export async function getIncident(req: Request, res: Response): Promise<void> {
  const { id } = parseParams(req, uuidParamSchema);

  const incident = await prisma.incident.findUnique({
    where: { id },
    include: {
      service: SERVICE_FIELDS,
      assignee: ASSIGNEE_FIELDS,
      events: { orderBy: { createdAt: 'asc' } },
    },
  });

  if (!incident) throw new NotFoundError('Incident');

  sendSuccess(res, incident);
}

export async function createIncident(req: Request, res: Response): Promise<void> {
  const actor = requireUser(req);
  const input = parseBody(req, createIncidentSchema);

  if (input.serviceId) {
    const service = await prisma.service.findUnique({ where: { id: input.serviceId } });
    if (!service) throw new BadRequestError('serviceId does not refer to a known service');
  }

  const incident = await prisma.$transaction(async (tx) => {
    const created = await tx.incident.create({
      data: {
        ...input,
        // Manually raised incidents carry no dedupe key: they describe a
        // situation a person judged worth tracking, and two of them for the
        // same service are legitimate.
        source: IncidentSource.MANUAL,
        status: IncidentStatus.INVESTIGATING,
        isOpen: true,
      },
      include: { service: SERVICE_FIELDS, assignee: ASSIGNEE_FIELDS },
    });

    await tx.incidentEvent.create({
      data: {
        incidentId: created.id,
        kind: IncidentEventKind.OPENED,
        message: `Opened by ${actor.name}`,
        actorId: actor.id,
      },
    });

    /**
     * The timeline and the audit trail answer different questions and have
     * different audiences. The timeline is the narrative of one incident, shown
     * to anybody who can see it and including everything the machines did. The
     * audit trail is administrator-only, queryable by actor across the whole
     * system, and records only what a person chose to do. Neither substitutes
     * for the other, which is why this writes both.
     */
    await recordAuditIn(tx, req, actor.id, {
      action: AuditAction.INCIDENT_CREATED,
      resource: 'incident',
      resourceId: created.id,
      metadata: {
        title: created.title,
        severity: created.severity,
        serviceId: created.serviceId,
      },
    });

    return created;
  });

  sendSuccess(res, incident, undefined, 201);
}

/**
 * Updates an incident and records what changed.
 *
 * Every mutation appends a timeline entry in the same transaction as the
 * update. If the two could diverge, the timeline would stop being a reliable
 * account of the incident, which is the only thing it is for.
 */
export async function updateIncident(req: Request, res: Response): Promise<void> {
  const actor = requireUser(req);
  const { id } = parseParams(req, uuidParamSchema);
  const input = parseBody(req, updateIncidentSchema);

  const existing = await prisma.incident.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Incident');

  if (input.assigneeId) {
    const assignee = await prisma.user.findUnique({ where: { id: input.assigneeId } });
    if (!assignee) throw new BadRequestError('assigneeId does not refer to a known user');
  }

  const events: Prisma.IncidentEventCreateManyInput[] = [];
  const push = (kind: IncidentEventKind, message: string) =>
    events.push({ incidentId: id, kind, message, actorId: actor.id });

  /**
   * One audit row per state transition, carrying the before and after values.
   * "Somebody edited this incident" is not accountability; "this person moved
   * it from CRITICAL to LOW at 03:14" is.
   */
  const audits: { action: AuditAction; metadata: Prisma.InputJsonValue }[] = [];
  const audit = (action: AuditAction, metadata: Prisma.InputJsonValue) =>
    audits.push({ action, metadata });

  if (input.status && input.status !== existing.status) {
    push(
      input.status === IncidentStatus.RESOLVED
        ? IncidentEventKind.RESOLVED
        : existing.status === IncidentStatus.RESOLVED
          ? IncidentEventKind.REOPENED
          : IncidentEventKind.STATUS_CHANGED,
      `${actor.name} changed status from ${existing.status} to ${input.status}`,
    );
    audit(AuditAction.INCIDENT_STATUS_CHANGED, { from: existing.status, to: input.status });
  }

  if (input.severity && input.severity !== existing.severity) {
    push(
      IncidentEventKind.SEVERITY_CHANGED,
      `${actor.name} changed severity from ${existing.severity} to ${input.severity}`,
    );
    audit(AuditAction.INCIDENT_SEVERITY_CHANGED, {
      from: existing.severity,
      to: input.severity,
    });
  }

  if (input.assigneeId !== undefined && input.assigneeId !== existing.assigneeId) {
    push(
      IncidentEventKind.ASSIGNED,
      input.assigneeId
        ? `${actor.name} assigned this incident`
        : `${actor.name} removed the assignee`,
    );
    audit(AuditAction.INCIDENT_ASSIGNED, {
      from: existing.assigneeId,
      to: input.assigneeId,
    });
  }

  /**
   * `isOpen` is derived from status here rather than accepted from the client,
   * so the flag the deduplication index depends on can never disagree with the
   * status a user sees.
   */
  const resolving = input.status === IncidentStatus.RESOLVED;
  const reopening =
    existing.status === IncidentStatus.RESOLVED &&
    input.status !== undefined &&
    input.status !== IncidentStatus.RESOLVED;

  const incident = await prisma.$transaction(async (tx) => {
    const updated = await tx.incident.update({
      where: { id },
      data: {
        ...input,
        ...(resolving ? { isOpen: false, resolvedAt: new Date() } : {}),
        ...(reopening ? { isOpen: true, resolvedAt: null } : {}),
      },
      include: { service: SERVICE_FIELDS, assignee: ASSIGNEE_FIELDS },
    });

    if (events.length > 0) {
      await tx.incidentEvent.createMany({ data: events });
    }

    for (const entry of audits) {
      await recordAuditIn(tx, req, actor.id, {
        action: entry.action,
        resource: 'incident',
        resourceId: id,
        metadata: entry.metadata,
      });
    }

    return updated;
  });

  sendSuccess(res, incident);
}

/** Appends a human note to the timeline. */
export async function addComment(req: Request, res: Response): Promise<void> {
  const actor = requireUser(req);
  const { id } = parseParams(req, uuidParamSchema);
  const { message } = parseBody(req, addCommentSchema);

  const exists = await prisma.incident.findUnique({ where: { id }, select: { id: true } });
  if (!exists) throw new NotFoundError('Incident');

  const event = await prisma.incidentEvent.create({
    data: {
      incidentId: id,
      kind: IncidentEventKind.COMMENTED,
      message,
      actorId: actor.id,
    },
  });

  sendSuccess(res, event, undefined, 201);
}

/**
 * Counts by status and severity, for the dashboard summary.
 *
 * Aggregated in the database rather than by fetching every incident and
 * counting in JavaScript, which is the version that works fine in development
 * and falls over on a year of history.
 */
export async function getIncidentSummary(_req: Request, res: Response): Promise<void> {
  const [bySeverity, total, open] = await prisma.$transaction([
    prisma.incident.groupBy({
      by: ['severity'],
      where: { isOpen: true },
      _count: { _all: true },
    }),
    prisma.incident.count(),
    prisma.incident.count({ where: { isOpen: true } }),
  ]);

  sendSuccess(res, {
    total,
    open,
    resolved: total - open,
    openBySeverity: Object.fromEntries(bySeverity.map((row) => [row.severity, row._count._all])),
  });
}
