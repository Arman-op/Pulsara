import { Role } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';
import { ForbiddenError } from '../lib/errors';
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
  return function authorize(req: Request, _res: Response, next: NextFunction): void {
    /**
     * `protect` has already read this account from the database and written the
     * current role onto the request, so this is a pure comparison.
     *
     * It used to do its own lookup, because only privileged routes re-read the
     * database and an access token's role claim could be stale. Making that
     * check universal moved it into `protect`, where it protects every route
     * rather than the subset somebody remembered to mark.
     */
    const { role } = requireUser(req);

    if (ROLE_RANK[role] < ROLE_RANK[minimumRole]) {
      next(new ForbiddenError(`This action requires the ${minimumRole} role`));
      return;
    }

    next();
  };
}

/** Convenience guards for the two levels routes actually distinguish today. */
export const requireAdmin = requireRole(Role.ADMIN);
export const requireMember = requireRole(Role.MEMBER);
