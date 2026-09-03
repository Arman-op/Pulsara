import { createHash, randomUUID } from 'node:crypto';
import { Role, type Prisma, type User } from '@prisma/client';
import type { DecodedIdToken } from 'firebase-admin/auth';
import { MS_PER_DAY } from '../../config/constants';
import { env, isFirebaseConfigured } from '../../config/env';
import { prisma } from '../../db/prisma';
import { ForbiddenError, UnauthenticatedError, UpstreamUnavailableError } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { invalidatePrincipal } from './principal';
import type { AuthenticatedUser } from './auth.types';
import { verifyFirebaseIdToken } from './firebase';
import { hashPassword, verifyPassword } from './password';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from './tokens';

/**
 * Authentication and session management.
 *
 * What this replaces: the previous controller compared the submitted password
 * against the literal string "password" and, on success, issued tokens for a
 * hard-coded MOCK_USER. Because the condition was
 * `email === MOCK_USER.email || password === 'password'`, any email address
 * paired with that password authenticated as an administrator, and the refresh
 * endpoint returned the mock administrator regardless of whose refresh token
 * was presented.
 */

export type SessionContext = {
  userAgent?: string | undefined;
  ipAddress?: string | undefined;
};

export type IssuedSession = {
  user: AuthenticatedUser;
  accessToken: string;
  refreshToken: string;
  /** Absolute expiry, so the caller can set a matching cookie lifetime. */
  refreshTokenExpiresAt: Date;
  /** Row id of the issued refresh token, used to link the rotation chain. */
  refreshTokenId: string;
};

/**
 * Raised when a refresh token is claimed by another request between this
 * request reading it and attempting to rotate it. It never leaves this module:
 * the caller translates it into the same response a replay attempt receives.
 */
class ConcurrentRotationError extends Error {}

/**
 * A pre-computed Argon2id digest of a value no user can supply.
 *
 * When an email does not exist we still run a verification against this digest.
 * Skipping the hash would let an attacker enumerate valid accounts purely by
 * timing: a miss would return in microseconds, while a hit spends tens of
 * milliseconds inside the memory-hard function.
 */
let timingEqualisationDigest: string | null = null;

async function equaliseFailureTiming(): Promise<void> {
  timingEqualisationDigest ??= await hashPassword(randomUUID());
  await verifyPassword(timingEqualisationDigest, randomUUID());
}

function toAuthenticatedUser(user: User): AuthenticatedUser {
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}

/** Refresh tokens are stored as digests so a database leak yields no sessions. */
function digestToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Issues an access/refresh pair and records the refresh token.
 *
 * The row id is generated first so it can be embedded as the JWT `jti`, which
 * means every refresh token presented later maps to exactly one row.
 */
async function issueSession(
  user: User,
  context: SessionContext,
  tx: Prisma.TransactionClient = prisma,
): Promise<IssuedSession> {
  const tokenId = randomUUID();
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * MS_PER_DAY);
  const refreshToken = signRefreshToken(user.id, tokenId);

  await tx.refreshToken.create({
    data: {
      id: tokenId,
      userId: user.id,
      tokenHash: digestToken(refreshToken),
      expiresAt,
      userAgent: context.userAgent ?? null,
      ipAddress: context.ipAddress ?? null,
    },
  });

  const accessToken = signAccessToken(user.id, {
    email: user.email,
    name: user.name,
    role: user.role,
  });

  return {
    user: toAuthenticatedUser(user),
    accessToken,
    refreshToken,
    refreshTokenExpiresAt: expiresAt,
    refreshTokenId: tokenId,
  };
}

/**
 * Revokes every live session for a user.
 *
 * Deliberately not run inside a caller's transaction: the situations that need
 * it end by throwing, and a write enrolled in a transaction that then throws is
 * rolled back with it — which would silently undo the very revocation the
 * throw is meant to enforce.
 */
export async function revokeAllSessionsForUser(userId: string): Promise<void> {
  const revokedAt = new Date();

  /**
   * Both halves, in one transaction. Revoking the refresh tokens ends a
   * session's ability to *renew*; stamping `sessionsValidFrom` is what stops
   * the access tokens already in someone's hands, which stay cryptographically
   * valid until they expire. Doing only the first left a stolen token working
   * for the rest of its lifetime — the exact window this is meant to close.
   */
  await prisma.$transaction([
    prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt },
    }),
    prisma.user.update({ where: { id: userId }, data: { sessionsValidFrom: revokedAt } }),
  ]);

  // Explicit rather than left to a TTL: a revocation that takes effect in ten
  // seconds is a revocation that does not work.
  await invalidatePrincipal(userId);
}

/**
 * The first account to exist in an empty deployment becomes the administrator;
 * everyone afterwards starts read-only and must be promoted deliberately.
 *
 * The previous federated login handler set `role: 'ADMIN'` on every new Google
 * account, so anyone with a Google account who reached the login page became an
 * administrator of the dashboard.
 */
async function resolveRoleForNewUser(tx: Prisma.TransactionClient): Promise<Role> {
  const existingUsers = await tx.user.count();
  return existingUsers === 0 ? Role.ADMIN : Role.VIEWER;
}

export async function loginWithPassword(
  email: string,
  password: string,
  context: SessionContext,
): Promise<IssuedSession> {
  const user = await prisma.user.findUnique({ where: { email } });

  if (!user?.passwordHash) {
    // Covers three cases with one response: no such account, an account that
    // signs in only through Google, and a wrong password. Distinguishing them
    // would turn the login form into an account-enumeration oracle.
    await equaliseFailureTiming();
    throw new UnauthenticatedError('Invalid email or password');
  }

  const passwordMatches = await verifyPassword(user.passwordHash, password);
  if (!passwordMatches) {
    throw new UnauthenticatedError('Invalid email or password');
  }

  if (!user.isActive) {
    throw new ForbiddenError('This account has been deactivated');
  }

  const session = await issueSession(user, context);
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  return session;
}

export async function loginWithFirebase(
  idToken: string,
  context: SessionContext,
): Promise<IssuedSession> {
  if (!isFirebaseConfigured) {
    throw new UpstreamUnavailableError('Federated sign-in is not configured on this deployment');
  }

  let decoded: DecodedIdToken;
  try {
    decoded = await verifyFirebaseIdToken(idToken);
  } catch (error) {
    logger.warn({ err: error }, 'Firebase ID token verification failed');
    throw new UnauthenticatedError('Google sign-in could not be verified');
  }

  const email = decoded.email?.toLowerCase();
  if (!email || decoded.email_verified !== true) {
    // An unverified address may belong to someone else entirely; linking it
    // would let an attacker take over an existing Pulsara account by claiming
    // its email at the identity provider.
    throw new UnauthenticatedError('A verified Google email address is required');
  }

  /**
   * `DecodedIdToken` types `name` only through its catch-all index signature,
   * so it arrives as `any`. Narrow it explicitly and fall back to the local
   * part of the email rather than trusting an unvalidated claim.
   */
  const claimedName: unknown = decoded.name;
  const displayName =
    typeof claimedName === 'string' && claimedName.trim().length > 0
      ? claimedName.trim()
      : (email.split('@')[0] ?? email);

  const user = await prisma.$transaction(async (tx) => {
    const existing = await tx.user.findUnique({ where: { email } });

    if (existing) {
      if (!existing.isActive) {
        throw new ForbiddenError('This account has been deactivated');
      }
      return tx.user.update({
        where: { id: existing.id },
        data: {
          firebaseUid: decoded.uid,
          // The identity provider stays authoritative for the profile picture.
          avatarUrl: decoded.picture ?? existing.avatarUrl,
          lastLoginAt: new Date(),
        },
      });
    }

    return tx.user.create({
      data: {
        email,
        name: displayName,
        firebaseUid: decoded.uid,
        avatarUrl: decoded.picture ?? null,
        role: await resolveRoleForNewUser(tx),
        lastLoginAt: new Date(),
      },
    });
  });

  return issueSession(user, context);
}

/**
 * Exchanges a refresh token for a new pair, rotating the old one out.
 *
 * Each refresh token is single-use. If a token that has already been rotated is
 * presented again, either an attacker replayed it or the legitimate client is
 * retrying, and the server cannot tell which. The safe response is to assume
 * compromise and revoke every session for that user.
 */
export async function rotateSession(
  presentedToken: string,
  context: SessionContext,
): Promise<IssuedSession> {
  const claims = verifyRefreshToken(presentedToken);
  const tokenId = typeof claims?.jti === 'string' ? claims.jti : null;
  const subject = typeof claims?.sub === 'string' ? claims.sub : null;

  if (!tokenId || !subject) {
    throw new UnauthenticatedError('Refresh token is invalid or has expired');
  }

  const stored = await prisma.refreshToken.findUnique({
    where: { id: tokenId },
    include: { user: true },
  });

  // A signed token whose row is missing, whose digest does not match, or that
  // names a different subject, is forged or comes from a wiped database.
  if (!stored || stored.tokenHash !== digestToken(presentedToken) || stored.userId !== subject) {
    throw new UnauthenticatedError('Refresh token is invalid or has expired');
  }

  if (stored.revokedAt) {
    logger.error(
      { userId: stored.userId, tokenId },
      'Refresh token reuse detected; revoking every session for this user',
    );
    await revokeAllSessionsForUser(stored.userId);
    throw new UnauthenticatedError('Session has been revoked; please sign in again');
  }

  if (stored.expiresAt <= new Date()) {
    throw new UnauthenticatedError('Refresh token is invalid or has expired');
  }

  if (!stored.user.isActive) {
    throw new ForbiddenError('This account has been deactivated');
  }

  const user = stored.user;

  try {
    /**
     * Claim and replace atomically.
     *
     * The `revokedAt: null` predicate makes the update a compare-and-swap: of
     * two requests racing with the same token, exactly one sees `count === 1`.
     * Without it, a double-submit would mint two live sessions from a
     * single-use token.
     *
     * If issuing the replacement fails, the transaction rolls back and the
     * presented token stays valid, so a transient database error costs the user
     * a retry rather than their session.
     */
    return await prisma.$transaction(async (tx) => {
      const claimed = await tx.refreshToken.updateMany({
        where: { id: stored.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      if (claimed.count !== 1) {
        throw new ConcurrentRotationError();
      }

      const next = await issueSession(user, context, tx);

      await tx.refreshToken.update({
        where: { id: stored.id },
        data: { replacedByTokenId: next.refreshTokenId },
      });

      return next;
    });
  } catch (error) {
    if (error instanceof ConcurrentRotationError) {
      // Another request already consumed this token. Indistinguishable from a
      // replay, so it gets the same treatment.
      logger.error(
        { userId: user.id, tokenId },
        'Refresh token rotated concurrently; revoking every session for this user',
      );
      await revokeAllSessionsForUser(user.id);
      throw new UnauthenticatedError('Session has been revoked; please sign in again');
    }
    throw error;
  }
}

/** Revokes the presented session. An absent or unknown token is a no-op. */
export async function revokeSession(presentedToken: string | undefined): Promise<void> {
  if (!presentedToken) return;

  const claims = verifyRefreshToken(presentedToken);
  const tokenId = typeof claims?.jti === 'string' ? claims.jti : null;
  if (!tokenId) return;

  await prisma.refreshToken.updateMany({
    where: { id: tokenId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export type CurrentUser = AuthenticatedUser & {
  avatarUrl: string | null;
  lastLoginAt: Date | null;
};

/**
 * Loads the current user from the database rather than trusting token claims.
 *
 * An access token is a snapshot taken when it was issued. Reading through to
 * the row means a role change or a deactivation takes effect within one access
 * token lifetime, instead of persisting until the user happens to sign out.
 */
export async function getCurrentUser(userId: string): Promise<CurrentUser> {
  const user = await prisma.user.findUnique({ where: { id: userId } });

  if (!user?.isActive) {
    throw new UnauthenticatedError('Account is no longer active');
  }

  return { ...toAuthenticatedUser(user), avatarUrl: user.avatarUrl, lastLoginAt: user.lastLoginAt };
}
