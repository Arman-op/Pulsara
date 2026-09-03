import { AuditAction, Prisma, Role } from '@prisma/client';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../db/prisma';
import { recordAudit } from '../../lib/audit';
import { BadRequestError, ConflictError, NotFoundError } from '../../lib/errors';
import { pageMeta, sendSuccess } from '../../lib/http';
import {
  paginationSchema,
  parseBody,
  parseParams,
  parseQuery,
  uuidParamSchema,
} from '../../lib/validation';
import { requireUser } from '../../middleware/auth';
import { revokeAllSessionsForUser } from '../auth/auth.service';
import { invalidatePrincipal } from '../auth/principal';

/**
 * User administration.
 *
 * Without this, role-based access control was decorative: the first account
 * became ADMIN and every account after it was a VIEWER with no way to be
 * promoted, so the MEMBER and ADMIN roles could never be granted to anybody.
 */

/** Fields safe to return. `passwordHash` is never in this list. */
const PUBLIC_USER_FIELDS = {
  id: true,
  email: true,
  name: true,
  role: true,
  avatarUrl: true,
  isActive: true,
  lastLoginAt: true,
  createdAt: true,
} as const;

const listUsersQuerySchema = paginationSchema.extend({
  role: z.nativeEnum(Role).optional(),
  isActive: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),
});

const updateUserSchema = z
  .object({
    role: z.nativeEnum(Role).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => value.role !== undefined || value.isActive !== undefined, {
    message: 'at least one of role or isActive must be provided',
  });

export async function listUsers(req: Request, res: Response): Promise<void> {
  const { limit, offset, role, isActive } = parseQuery(req, listUsersQuerySchema);

  const where: Prisma.UserWhereInput = {
    ...(role ? { role } : {}),
    ...(isActive === undefined ? {} : { isActive }),
  };

  const [users, total] = await prisma.$transaction([
    prisma.user.findMany({
      where,
      take: limit,
      skip: offset,
      orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }],
      select: PUBLIC_USER_FIELDS,
    }),
    prisma.user.count({ where }),
  ]);

  sendSuccess(res, users, pageMeta(total, limit, offset));
}

/**
 * Counts administrators who can still sign in.
 *
 * Used to prevent the last one being removed, which would lock everybody out of
 * user administration with no way back in short of editing the database by hand.
 */
async function activeAdminCount(tx: Prisma.TransactionClient): Promise<number> {
  return tx.user.count({ where: { role: Role.ADMIN, isActive: true } });
}

export async function updateUser(req: Request, res: Response): Promise<void> {
  const actor = requireUser(req);
  const { id } = parseParams(req, uuidParamSchema);
  const input = parseBody(req, updateUserSchema);

  /**
   * An administrator cannot demote or deactivate themselves.
   *
   * Not merely a courtesy: a sole administrator who removes their own access
   * has no path back, and self-demotion is a common way to lock an environment
   * out entirely. Another administrator can still do it to them.
   */
  if (id === actor.id) {
    if (input.role !== undefined && input.role !== Role.ADMIN) {
      throw new BadRequestError('You cannot change your own role');
    }
    if (input.isActive === false) {
      throw new BadRequestError('You cannot deactivate your own account');
    }
  }

  /**
   * Serializable isolation, because the last-administrator check is a
   * read-then-write on a count.
   *
   * Under the default READ COMMITTED, two administrators demoting each other at
   * the same moment would both read a count of two, both pass the check, and
   * both commit — leaving the deployment with zero administrators and no way to
   * appoint one. Serializable makes one of the two transactions fail instead.
   */
  const updated = await prisma.$transaction(
    async (tx) => {
      const existing = await tx.user.findUnique({ where: { id } });
      if (!existing) throw new NotFoundError('User');

      const losingAdmin =
        existing.role === Role.ADMIN &&
        existing.isActive &&
        ((input.role !== undefined && input.role !== Role.ADMIN) || input.isActive === false);

      if (losingAdmin && (await activeAdminCount(tx)) <= 1) {
        throw new ConflictError(
          'This is the last active administrator; promote another account first',
        );
      }

      const user = await tx.user.update({
        where: { id },
        data: input,
        select: PUBLIC_USER_FIELDS,
      });

      return { user, existing };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );

  /**
   * Deactivation revokes every session immediately. Without this the account
   * would keep working until its refresh token expired, which is up to a week
   * of access for somebody who has just been removed.
   */
  if (input.isActive === false) {
    await revokeAllSessionsForUser(id);
  }

  /**
   * A role change has to reach `protect` at once as well. Without this the
   * demoted administrator keeps administrative power for as long as the cached
   * principal lives, which is the same bug in a smaller window.
   */
  await invalidatePrincipal(id);

  if (input.role !== undefined && input.role !== updated.existing.role) {
    recordAudit(req, actor.id, {
      action: AuditAction.USER_ROLE_CHANGED,
      resource: 'user',
      resourceId: id,
      metadata: { from: updated.existing.role, to: input.role, subjectEmail: updated.user.email },
    });
  }

  if (input.isActive !== undefined && input.isActive !== updated.existing.isActive) {
    recordAudit(req, actor.id, {
      action: input.isActive ? AuditAction.USER_REACTIVATED : AuditAction.USER_DEACTIVATED,
      resource: 'user',
      resourceId: id,
      metadata: { subjectEmail: updated.user.email },
    });
  }

  sendSuccess(res, updated.user);
}

/**
 * The audit trail.
 *
 * Administrator-only: it records who did what, which is itself sensitive.
 */
export async function listAuditLog(req: Request, res: Response): Promise<void> {
  const { limit, offset } = parseQuery(req, paginationSchema);

  const [entries, total] = await prisma.$transaction([
    prisma.auditLog.findMany({
      take: limit,
      skip: offset,
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { id: true, name: true, email: true } } },
    }),
    prisma.auditLog.count(),
  ]);

  sendSuccess(res, entries, pageMeta(total, limit, offset));
}
