import { Role } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';
import { prisma } from '../db/prisma';
import { ForbiddenError, UnauthenticatedError } from '../lib/errors';
import { requireUser } from './auth';

/**
 * Role-based authorization.
 *
 * Roles are ordered, not a flat set: an administrator can do anything a member
 * can, and a member anything a viewer can. Encoding that as a rank means a route
 * declares the *minimum* role it needs and never has to be revisited when a new
 * role is inserted into the hierarchy.
 *
 * Previously the `role` claim was carried in every token and rendered in the UI
 * but never checked on the server, so any authenticated principal could reach
 * every endpoint regardless of the role their session claimed.
 */

const ROLE_RANK: Record<Role, number> = {
  [Role.VIEWER]: 0,
  [Role.MEMBER]: 1,
  [Role.ADMIN]: 2,
};

export function requireRole(minimumRole: Role) {
  return async function authorize(req: Request, _res: Response, next: NextFunction): Promise<void> {
    const claimed = requireUser(req);

    /**
     * The role is re-read from the database rather than trusted from the token.
     *
     * An access token is a snapshot from when it was issued. Without this
     * lookup, an administrator who was demoted or deactivated thirty seconds
     * ago keeps full administrative power until their token expires — up to the
     * whole access token lifetime — which is exactly the window in which
     * somebody's access is being revoked for a reason.
     *
     * The cost is one indexed primary-key lookup, and it is paid only on
     * privileged routes; ordinary authenticated reads still go through
     * `protect` alone.
     */
    const current = await prisma.user.findUnique({
      where: { id: claimed.id },
      select: { role: true, isActive: true },
    });

    if (!current?.isActive) {
      next(new UnauthenticatedError('Account is no longer active'));
      return;
    }

    if (ROLE_RANK[current.role] < ROLE_RANK[minimumRole]) {
      next(new ForbiddenError(`This action requires the ${minimumRole} role`));
      return;
    }

    // Keep the request's view of the principal consistent with the database, so
    // a handler that reads `req.user.role` sees the same answer this guard used.
    req.user = { ...claimed, role: current.role };
    next();
  };
}

/** Convenience guards for the two levels routes actually distinguish today. */
export const requireAdmin = requireRole(Role.ADMIN);
export const requireMember = requireRole(Role.MEMBER);
