import type { AuthenticatedUser } from '../modules/auth/auth.types';

/**
 * Attaches the authenticated principal to the request type.
 *
 * The previous code reached for `req.user` behind a `@ts-ignore`, which meant
 * every consumer silently operated on `any`. Declaring it here gives handlers a
 * real type, and marking it optional forces each one to prove the request went
 * through the authentication middleware before dereferencing it.
 */
declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

export {};
