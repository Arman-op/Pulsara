import { AuditAction } from '@prisma/client';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../db/prisma';
import { recordAudit } from '../../lib/audit';
import { BadRequestError, UnauthenticatedError } from '../../lib/errors';
import { sendSuccess } from '../../lib/http';
import { parseBody } from '../../lib/validation';
import { requireUser } from '../../middleware/auth';
import { passwordSchema } from './auth.schemas';
import { hashPassword, verifyPassword } from './password';
import { revokeAllSessionsForUser } from './auth.service';

/**
 * Self-service account management.
 *
 * The Settings screen previously rendered these controls as inert markup: the
 * profile form had no submit handler, and the password form submitted nowhere.
 * These are the endpoints that make them real.
 */

const MAX_NAME_LENGTH = 120;
const MAX_AVATAR_URL_LENGTH = 2048;

const updateProfileSchema = z
  .object({
    name: z.string().trim().min(1).max(MAX_NAME_LENGTH).optional(),
    avatarUrl: z.string().trim().max(MAX_AVATAR_URL_LENGTH).url().nullable().optional(),
  })
  .refine((value) => value.name !== undefined || value.avatarUrl !== undefined, {
    message: 'at least one field must be provided',
  });

/**
 * Email is deliberately not editable here.
 *
 * It is the identifier a federated account is matched on and the one a password
 * reset would be sent to, so changing it is an identity change that needs a
 * verification round-trip rather than a text input. Leaving it out is more
 * honest than accepting the edit and silently ignoring it.
 */
export async function updateProfile(req: Request, res: Response): Promise<void> {
  const actor = requireUser(req);
  const input = parseBody(req, updateProfileSchema);

  const user = await prisma.user.update({
    where: { id: actor.id },
    data: input,
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      avatarUrl: true,
      lastLoginAt: true,
    },
  });

  recordAudit(req, actor.id, {
    action: AuditAction.USER_PROFILE_UPDATED,
    resource: 'user',
    resourceId: actor.id,
    metadata: { fields: Object.keys(input) },
  });

  sendSuccess(res, user);
}

const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'is required'),
    newPassword: passwordSchema,
  })
  .refine((value) => value.currentPassword !== value.newPassword, {
    path: ['newPassword'],
    message: 'must differ from the current password',
  });

/**
 * Changes the caller's password.
 *
 * Requires the current password even though the caller is already
 * authenticated: an access token left behind on a shared machine should not be
 * enough to lock the real owner out of their own account.
 *
 * On success **every** session is revoked, including this one. If the account
 * was compromised, the attacker's session is exactly what the password change
 * is meant to terminate; keeping the current session alive for convenience
 * would defeat the point. The client signs in again with the new password.
 */
export async function changePassword(req: Request, res: Response): Promise<void> {
  const actor = requireUser(req);
  const { currentPassword, newPassword } = parseBody(req, changePasswordSchema);

  const user = await prisma.user.findUnique({ where: { id: actor.id } });
  if (!user) throw new UnauthenticatedError('Account no longer exists');

  if (!user.passwordHash) {
    throw new BadRequestError('This account signs in with Google and has no password to change');
  }

  if (!(await verifyPassword(user.passwordHash, currentPassword))) {
    throw new UnauthenticatedError('Current password is incorrect');
  }

  await prisma.user.update({
    where: { id: actor.id },
    data: { passwordHash: await hashPassword(newPassword) },
  });

  await revokeAllSessionsForUser(actor.id);

  recordAudit(req, actor.id, {
    action: AuditAction.PASSWORD_CHANGED,
    resource: 'user',
    resourceId: actor.id,
  });

  sendSuccess(res, {
    changed: true,
    sessionsRevoked: true,
    message: 'Password updated. All sessions were signed out; please sign in again.',
  });
}

/**
 * Lists the caller's live sessions.
 *
 * Showing where an account is signed in is how a user notices one they do not
 * recognise, which is the only practical way most people detect a compromise.
 */
export async function listSessions(req: Request, res: Response): Promise<void> {
  const actor = requireUser(req);

  const sessions = await prisma.refreshToken.findMany({
    where: { userId: actor.id, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
    // The token digest is never returned; it is a credential equivalent.
    select: { id: true, userAgent: true, ipAddress: true, createdAt: true, expiresAt: true },
  });

  sendSuccess(res, sessions);
}

/** Signs the caller out everywhere. */
export async function revokeAllSessions(req: Request, res: Response): Promise<void> {
  const actor = requireUser(req);
  await revokeAllSessionsForUser(actor.id);

  recordAudit(req, actor.id, {
    action: AuditAction.SESSIONS_REVOKED,
    resource: 'user',
    resourceId: actor.id,
  });

  sendSuccess(res, { revoked: true });
}
