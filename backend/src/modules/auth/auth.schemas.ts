import { z } from 'zod';

/**
 * Wire contracts for the authentication endpoints.
 *
 * Every field is bounded. An unbounded string on a login form is a free
 * denial-of-service vector against the password hasher, which is expensive by
 * design: a megabyte-long "password" would otherwise consume real CPU on every
 * unauthenticated request.
 */

const MAX_EMAIL_LENGTH = 320; // RFC 5321 maximum
const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 128;
const MAX_ID_TOKEN_LENGTH = 8192;

/** Emails are stored and compared lower-cased; normalise at the boundary. */
export const emailSchema = z
  .string()
  .trim()
  .max(MAX_EMAIL_LENGTH)
  .email('must be a valid email address')
  .toLowerCase();

export const passwordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `must be at least ${MIN_PASSWORD_LENGTH} characters`)
  .max(MAX_PASSWORD_LENGTH, `must be at most ${MAX_PASSWORD_LENGTH} characters`);

export const loginSchema = z.object({
  email: emailSchema,
  // Login deliberately does not apply the strength policy: rejecting a short
  // password here would tell an attacker that the stored one is short too.
  password: z.string().min(1, 'is required').max(MAX_PASSWORD_LENGTH),
});

export const firebaseLoginSchema = z.object({
  idToken: z.string().min(1, 'is required').max(MAX_ID_TOKEN_LENGTH),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type FirebaseLoginInput = z.infer<typeof firebaseLoginSchema>;
