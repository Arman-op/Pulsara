import {
  IncidentEventKind,
  IncidentSource,
  IncidentStatus,
  Prisma,
  ServiceState,
  Severity,
} from '@prisma/client';
import { prisma } from '../../db/prisma';
import { logger } from '../../lib/logger';
import type { ServiceStatusChange } from '../telemetry/probe-scheduler';

/**
 * Alerting engine.
 *
 * Turns observed service state transitions into incidents, and closes them
 * again when the service recovers. Every incident it opens is backed by real
 * probe results; nothing here invents a condition.
 *
 * The previous seed wrote two fixed incidents ("High latency on Background
 * Workers", "Database connection drop") that were never created by anything
 * observing anything, never changed, and never resolved.
 */

/** Severity implied by the state a service has entered. */
const SEVERITY_BY_STATE: Partial<Record<ServiceState, Severity>> = {
  [ServiceState.OFFLINE]: Severity.CRITICAL,
  [ServiceState.DEGRADED]: Severity.MEDIUM,
};

/**
 * Identity of the *condition*, not of an occurrence.
 *
 * Keyed by service alone rather than by service and state, so a service that
 * slides from DEGRADED to OFFLINE escalates the incident it already has instead
 * of opening a second one for the same outage.
 */
function dedupeKeyFor(serviceId: string): string {
  return `service-availability:${serviceId}`;
}

/** Postgres error code for a unique constraint violation. */
const UNIQUE_VIOLATION = 'P2002';

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === UNIQUE_VIOLATION;
}

/** Human-readable summary of the state a service is in. */
function titleFor(serviceName: string, state: ServiceState): string {
  return state === ServiceState.OFFLINE
    ? serviceName + ' is unreachable'
    : serviceName + ' is degraded';
}

function describeTransition(change: ServiceStatusChange): string {
  const reason = change.error ? ` (${change.error})` : '';
  return `${change.name} moved from ${change.previous} to ${change.current}${reason}`;
}

/**
 * Opens an incident for a newly unhealthy service, or escalates the one that is
 * already open.
 */
async function openOrEscalate(change: ServiceStatusChange, severity: Severity): Promise<void> {
  const dedupeKey = dedupeKeyFor(change.serviceId);

  const existing = await prisma.incident.findFirst({
    where: { dedupeKey, isOpen: true },
  });

  if (existing) {
    /**
     * Severity only ever escalates while an incident is open. Downgrading a
     * CRITICAL outage to MEDIUM because one probe happened to succeed would
     * quietly drop it below whatever threshold a human is watching, in the
     * middle of the outage.
     */
    if (severityRank(severity) <= severityRank(existing.severity)) return;

    await prisma.$transaction([
      prisma.incident.update({
        where: { id: existing.id },
        data: {
          severity,
          // The title is restated to match the state the service is actually
          // in. Leaving it as "is degraded" on an incident that has escalated
          // to a full outage misdescribes the situation in exactly the list
          // view an on-call engineer scans first.
          title: titleFor(change.name, change.current),
          description: describeTransition(change),
        },
      }),
      prisma.incidentEvent.create({
        data: {
          incidentId: existing.id,
          kind: IncidentEventKind.SEVERITY_CHANGED,
          message: `Severity raised from ${existing.severity} to ${severity}: ${describeTransition(change)}`,
        },
      }),
    ]);

    logger.warn(
      { service: change.name, from: existing.severity, to: severity },
      'Escalated open incident',
    );
    return;
  }

  try {
    await prisma.$transaction(async (tx) => {
      const incident = await tx.incident.create({
        data: {
          title: titleFor(change.name, change.current),
          description: describeTransition(change),
          severity,
          status: IncidentStatus.INVESTIGATING,
          source: IncidentSource.AUTOMATED,
          serviceId: change.serviceId,
          dedupeKey,
          isOpen: true,
        },
      });

      await tx.incidentEvent.create({
        data: {
          incidentId: incident.id,
          kind: IncidentEventKind.OPENED,
          message: describeTransition(change),
        },
      });
    });

    logger.warn({ service: change.name, severity }, 'Opened incident from observed outage');
  } catch (error) {
    /**
     * The partial unique index on (dedupeKey) WHERE isOpen is what makes this
     * safe under concurrency: if another tick opened the incident between the
     * lookup above and this insert, the constraint rejects the duplicate and
     * "already open" is exactly the right interpretation.
     */
    if (isUniqueViolation(error)) {
      logger.debug({ service: change.name }, 'Incident already open for this condition');
      return;
    }
    throw error;
  }
}

const SEVERITY_ORDER: Record<Severity, number> = {
  [Severity.LOW]: 0,
  [Severity.MEDIUM]: 1,
  [Severity.HIGH]: 2,
  [Severity.CRITICAL]: 3,
};

function severityRank(severity: Severity): number {
  return SEVERITY_ORDER[severity];
}

/** Closes the automated incident for a service that has recovered. */
async function resolveForRecovery(change: ServiceStatusChange): Promise<void> {
  const dedupeKey = dedupeKeyFor(change.serviceId);

  const open = await prisma.incident.findFirst({ where: { dedupeKey, isOpen: true } });
  if (!open) return;

  /**
   * Only incidents this engine opened are auto-resolved. A person who opened an
   * incident by hand may be tracking something the probe cannot see, and having
   * the scheduler close their investigation because one endpoint answered 200
   * would be worse than leaving it open.
   */
  if (open.source !== IncidentSource.AUTOMATED) {
    logger.info(
      { service: change.name, incidentId: open.id },
      'Service recovered but the open incident is manual; leaving it for a human',
    );
    return;
  }

  const resolvedAt = new Date();
  const openDurationMs = resolvedAt.getTime() - open.createdAt.getTime();

  await prisma.$transaction([
    prisma.incident.update({
      where: { id: open.id },
      data: { status: IncidentStatus.RESOLVED, isOpen: false, resolvedAt },
    }),
    prisma.incidentEvent.create({
      data: {
        incidentId: open.id,
        kind: IncidentEventKind.RESOLVED,
        message: `${change.name} recovered to ${change.current} after ${Math.round(openDurationMs / 1000)}s`,
      },
    }),
  ]);

  logger.info(
    { service: change.name, incidentId: open.id, openDurationMs },
    'Auto-resolved incident after observed recovery',
  );
}

/**
 * Reacts to one status transition.
 *
 * Called by the probe scheduler for every change it records. Failures are
 * logged rather than propagated: an alerting problem must never stop the
 * monitoring that feeds it.
 */
export async function handleServiceStatusChange(change: ServiceStatusChange): Promise<void> {
  try {
    if (change.current === ServiceState.ONLINE) {
      await resolveForRecovery(change);
      return;
    }

    /**
     * Entering maintenance is a planned action, not an outage, so it opens
     * nothing. Any incident already open stays open: a service that was
     * genuinely broken before the window began is still broken.
     */
    if (change.current === ServiceState.MAINTENANCE) return;

    const severity = SEVERITY_BY_STATE[change.current];
    if (!severity) return;

    await openOrEscalate(change, severity);
  } catch (error) {
    logger.error({ err: error, service: change.name }, 'Alerting engine failed to process change');
  }
}
