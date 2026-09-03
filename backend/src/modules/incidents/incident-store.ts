import {
  IncidentEventKind,
  IncidentSource,
  IncidentStatus,
  Prisma,
  Severity,
} from '@prisma/client';
import { prisma } from '../../db/prisma';
import { logger } from '../../lib/logger';

/**
 * The write path every automated alert source shares.
 *
 * There are two sources now — service reachability and host resource pressure —
 * and they agree on everything that matters: an incident is identified by the
 * *condition* rather than the occurrence, severity escalates but never falls
 * while an incident is open, a duplicate open is a race to be absorbed rather
 * than an error, and only what a machine opened may a machine close.
 *
 * Keeping those rules in one place is not tidiness. Each of them is a decision
 * somebody would otherwise re-make, differently, in the second implementation:
 * the de-escalation rule in particular looks like an obvious improvement until
 * you notice it silently drops an outage below the threshold a human is
 * watching, mid-outage.
 */

/** Postgres error code for a unique constraint violation. */
const UNIQUE_VIOLATION = 'P2002';

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === UNIQUE_VIOLATION;
}

const SEVERITY_ORDER: Record<Severity, number> = {
  [Severity.LOW]: 0,
  [Severity.MEDIUM]: 1,
  [Severity.HIGH]: 2,
  [Severity.CRITICAL]: 3,
};

export function severityRank(severity: Severity): number {
  return SEVERITY_ORDER[severity];
}

export type IncidentCondition = {
  /**
   * Identity of the condition, not of this occurrence. One key per thing that
   * can be wrong, so a condition that worsens escalates the incident it already
   * has instead of opening a second one for the same event.
   */
  dedupeKey: string;
  title: string;
  description: string;
  severity: Severity;
  /** Present when the condition is about a catalogued service. */
  serviceId?: string | null;
  /** Identifies the subject in logs, e.g. a service or metric name. */
  subject: string;
};

/**
 * Opens an incident for a condition, or escalates the one already open for it.
 *
 * Returns whether anything changed, so a caller can keep its own logging
 * meaningful without re-querying.
 */
export async function openOrEscalateIncident(condition: IncidentCondition): Promise<boolean> {
  const existing = await prisma.incident.findFirst({
    where: { dedupeKey: condition.dedupeKey, isOpen: true },
  });

  if (existing) {
    /**
     * Severity only ever rises while an incident is open. Downgrading a
     * CRITICAL condition to MEDIUM because one sample came back inside the line
     * would quietly drop it below whatever threshold a human is watching, in
     * the middle of the event.
     */
    if (severityRank(condition.severity) <= severityRank(existing.severity)) return false;

    await prisma.$transaction([
      prisma.incident.update({
        where: { id: existing.id },
        data: {
          severity: condition.severity,
          /**
           * The title is restated to match the state the subject is actually
           * in. Leaving "is degraded" on an incident that has escalated to a
           * full outage misdescribes it in exactly the list view an on-call
           * engineer scans first.
           */
          title: condition.title,
          description: condition.description,
        },
      }),
      prisma.incidentEvent.create({
        data: {
          incidentId: existing.id,
          kind: IncidentEventKind.SEVERITY_CHANGED,
          message: `Severity raised from ${existing.severity} to ${condition.severity}: ${condition.description}`,
        },
      }),
    ]);

    logger.warn(
      { subject: condition.subject, from: existing.severity, to: condition.severity },
      'Escalated open incident',
    );
    return true;
  }

  try {
    await prisma.$transaction(async (tx) => {
      const incident = await tx.incident.create({
        data: {
          title: condition.title,
          description: condition.description,
          severity: condition.severity,
          status: IncidentStatus.INVESTIGATING,
          source: IncidentSource.AUTOMATED,
          serviceId: condition.serviceId ?? null,
          dedupeKey: condition.dedupeKey,
          isOpen: true,
        },
      });

      await tx.incidentEvent.create({
        data: {
          incidentId: incident.id,
          kind: IncidentEventKind.OPENED,
          message: condition.description,
        },
      });
    });

    logger.warn(
      { subject: condition.subject, severity: condition.severity },
      'Opened incident from an observed condition',
    );
    return true;
  } catch (error) {
    /**
     * The partial unique index on (dedupeKey) WHERE isOpen is what makes this
     * safe under concurrency: if another tick opened the incident between the
     * lookup above and this insert, the constraint rejects the duplicate and
     * "already open" is exactly the right interpretation.
     */
    if (isUniqueViolation(error)) {
      logger.debug({ subject: condition.subject }, 'Incident already open for this condition');
      return false;
    }
    throw error;
  }
}

/**
 * Closes the automated incident for a condition that has cleared.
 *
 * `resolution` receives how long the incident was open, because "recovered
 * after 4s" and "recovered after 40 minutes" are the same sentence with very
 * different meanings and the caller is the one that can phrase it.
 */
export async function resolveAutomatedIncident(
  dedupeKey: string,
  subject: string,
  resolution: (openDurationMs: number) => string,
): Promise<boolean> {
  const open = await prisma.incident.findFirst({ where: { dedupeKey, isOpen: true } });
  if (!open) return false;

  /**
   * Only incidents this engine opened are auto-resolved. A person who opened an
   * incident by hand may be tracking something the machine cannot see, and
   * having a scheduler close their investigation because one sample looked fine
   * would be worse than leaving it open.
   */
  if (open.source !== IncidentSource.AUTOMATED) {
    logger.info(
      { subject, incidentId: open.id },
      'Condition cleared but the open incident is manual; leaving it for a human',
    );
    return false;
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
        message: resolution(openDurationMs),
      },
    }),
  ]);

  logger.info(
    { subject, incidentId: open.id, openDurationMs },
    'Auto-resolved incident after an observed recovery',
  );
  return true;
}
