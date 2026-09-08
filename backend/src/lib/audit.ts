import type { AuditAction, Prisma } from '@prisma/client';
import type { Request } from 'express';
import { prisma } from '../db/prisma';
import { logger } from './logger';

/**
 * Audit trail.
 *
 * The `AuditLog` table existed in the schema from the start but nothing ever
 * wrote to it. It now records the privileged actions that matter after an
 * incident, and that somebody is most likely to want to deny having taken: role
 * grants, deactivations, password changes and configuration edits.
 */

export type AuditEntry = {
  action: AuditAction;
  /** The kind of thing acted on, e.g. `user`, `service`. */
  resource: string;
  resourceId?: string | undefined;
  /**
   * Structured before/after detail.
   *
   * Must never contain a credential. The logger redacts password-shaped fields
   * on the way to stdout, but this is written straight to a durable table, so
   * the responsibility sits with the caller.
   */
  metadata?: Prisma.InputJsonValue | undefined;
};

/**
 * Records an action.
 *
 * Deliberately not awaited by its callers on the request path, and deliberately
 * failure-tolerant: losing an audit row is bad, but failing a legitimate
 * administrative action because the audit insert hit a constraint is worse. A
 * failure is logged at error level so it is still visible.
 *
 * The trade-off is stated here rather than left implicit, because the opposite
 * choice — refusing the action when it cannot be audited — is the right one in
 * regulated environments, and this is the line to change.
 */
/**
 * Records an action inside a caller's transaction.
 *
 * The opposite trade-off to `recordAudit` below, and appropriate where the
 * caller is already writing atomically for its own reasons. Incident mutations
 * are the case in point: the timeline entry and the state change must commit
 * together or the timeline stops being a reliable account, and once that
 * transaction exists the audit row rides along in it for free — with the
 * stronger guarantee that an audited action either happened and was recorded,
 * or did neither.
 */
export async function recordAuditIn(
  tx: Prisma.TransactionClient,
  req: Request,
  actorId: string,
  entry: AuditEntry,
): Promise<void> {
  await tx.auditLog.create({
    data: {
      action: entry.action,
      resource: entry.resource,
      resourceId: entry.resourceId ?? null,
      metadata: entry.metadata ?? undefined,
      userId: actorId,
      ipAddress: req.ip ?? null,
    },
  });
}

export function recordAudit(req: Request, actorId: string, entry: AuditEntry): void {
  void prisma.auditLog
    .create({
      data: {
        action: entry.action,
        resource: entry.resource,
        resourceId: entry.resourceId ?? null,
        metadata: entry.metadata ?? undefined,
        userId: actorId,
        ipAddress: req.ip ?? null,
      },
    })
    .catch((error: unknown) => {
      logger.error({ err: error, action: entry.action }, 'Failed to write audit log entry');
    });
}
