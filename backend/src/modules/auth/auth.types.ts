import { z } from 'zod';
import { Role } from '@prisma/client';

/**
 * The authenticated principal, as carried in an access token and attached to
 * the request.
 *
 * Claims arriving from the network are parsed rather than cast. A token is
 * signed data, but its *shape* is still untrusted input: a token minted by an
 * older deployment can be validly signed and yet omit a field the current code
 * expects.
 */
export const accessTokenClaimsSchema = z.object({
  sub: z.string().uuid(),
  email: z.string().email(),
  name: z.string(),
  role: z.nativeEnum(Role),
  /**
   * Issue time in milliseconds.
   *
   * JWT's own `iat` has one-second resolution, which cannot distinguish a token
   * issued just before a revocation from one issued just after it inside the
   * same second — and both directions of rounding are wrong. Rounding up
   * refuses the token somebody has just signed in with; rounding down honours
   * the token the revocation was meant to kill.
   *
   * Optional, so tokens minted by a deployment that predates this claim are
   * still accepted; they fall back to second resolution rather than logging
   * everybody out at rollout.
   */
  iatMs: z.number().int().positive().optional(),
});

export type AccessTokenClaims = z.infer<typeof accessTokenClaimsSchema>;

export type AuthenticatedUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
};

export function claimsToUser(claims: AccessTokenClaims): AuthenticatedUser {
  return { id: claims.sub, email: claims.email, name: claims.name, role: claims.role };
}
