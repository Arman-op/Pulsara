import type { Role } from '@prisma/client';
import { MS_PER_SECOND } from '../../config/constants';
import { prisma } from '../../db/prisma';
import { CacheNamespace, cacheKey, cached, invalidateKey } from '../../lib/cache';

/**
 * The current, authoritative facts about an authenticated account.
 *
 * An access token is a snapshot of who somebody was when it was issued. That is
 * what makes it cheap, and it is also the whole problem: between issuing and
 * expiry the account can be demoted, deactivated, or have every session
 * deliberately revoked, and a token that is merely well-signed knows none of it.
 *
 * `protect` therefore checks these three facts on every authenticated request
 * rather than trusting the token's claims. The cost is one primary-key lookup,
 * served from Redis where it is configured and from PostgreSQL where it is not.
 *
 * This replaces the previous arrangement, where only privileged routes re-read
 * the database. That left the guarantee uneven — a demoted administrator was
 * refused at `/api/users` but still served everywhere else — and "which routes
 * are strict" is not a distinction anybody should have to hold in their head.
 */
export type Principal = {
  role: Role;
  isActive: boolean;
  /** Access tokens issued before this are refused. */
  sessionsValidFrom: Date | null;
};

type StoredPrincipal = Omit<Principal, 'sessionsValidFrom'> & {
  /** Serialised through JSON on the way to Redis, so dates arrive as strings. */
  sessionsValidFrom: string | null;
};

function keyFor(userId: string): string {
  return cacheKey(CacheNamespace.Principals, userId);
}

/**
 * Reads the account behind a token, or null when it no longer exists.
 *
 * Cached per user and invalidated explicitly by every operation that changes
 * one of these three facts, so the cache is exactly correct rather than
 * eventually correct — a revocation that took effect only after a TTL would be
 * a revocation that does not work.
 */
export async function loadPrincipal(userId: string): Promise<Principal | null> {
  const stored = await cached<StoredPrincipal | null>(keyFor(userId), async () => {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { role: true, isActive: true, sessionsValidFrom: true },
    });

    if (!user) return null;

    return {
      role: user.role,
      isActive: user.isActive,
      sessionsValidFrom: user.sessionsValidFrom?.toISOString() ?? null,
    };
  });

  if (!stored) return null;

  return {
    role: stored.role,
    isActive: stored.isActive,
    sessionsValidFrom: stored.sessionsValidFrom ? new Date(stored.sessionsValidFrom) : null,
  };
}

/**
 * The one caveat worth stating: a change made *outside* the application — a
 * migration, a psql session, another service writing to the same database —
 * is not invalidated and therefore takes effect within one cache TTL rather
 * than at once. Everything the API itself does invalidates explicitly, so this
 * bounds only out-of-band edits, and bounds them at seconds.
 */

/** Called by anything that demotes, deactivates or signs an account out. */
export async function invalidatePrincipal(userId: string): Promise<void> {
  await invalidateKey(keyFor(userId));
}

/**
 * Whether a token is still honoured, given when the account's sessions were
 * last revoked.
 *
 * `iatMs` is preferred because JWT's own `iat` has one-second resolution and
 * cannot distinguish a token issued just before a revocation from one issued
 * just after it inside the same second. Both directions of rounding are wrong:
 * rounding up refuses the token somebody has just signed in with, and rounding
 * down honours the token the revocation was meant to kill.
 *
 * Tokens from a deployment that predates the claim fall back to second
 * resolution, rounded down — lenient by at most a second, which is the right
 * failure for a compatibility path that disappears within one token lifetime.
 */
export function isIssuedAfterRevocation(
  issuedAt: { seconds: number | undefined; milliseconds: number | undefined },
  sessionsValidFrom: Date | null,
): boolean {
  if (!sessionsValidFrom) return true;

  if (issuedAt.milliseconds !== undefined) {
    return issuedAt.milliseconds >= sessionsValidFrom.getTime();
  }

  // A token that cannot be placed in time at all cannot be shown to post-date
  // a revocation.
  if (issuedAt.seconds === undefined) return false;

  return issuedAt.seconds >= Math.floor(sessionsValidFrom.getTime() / MS_PER_SECOND);
}
