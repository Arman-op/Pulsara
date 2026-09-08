import { hash, verify } from '@node-rs/argon2';

/**
 * Password hashing.
 *
 * Argon2id is the current OWASP first choice: it is memory-hard, so the
 * economics of a GPU or ASIC cracking rig are far worse than against bcrypt or
 * PBKDF2, and the `id` variant resists both side-channel and time-memory
 * trade-off attacks.
 *
 * The parameters below are OWASP's recommended configuration. They are pinned
 * explicitly rather than left to library defaults so that a dependency upgrade
 * cannot silently weaken every hash this service produces. Argon2 encodes its
 * parameters into the digest, so raising them later still verifies existing
 * hashes and lets us re-hash on next successful login.
 */
const ARGON2_MEMORY_COST_KIB = 19_456; // 19 MiB
const ARGON2_TIME_COST = 2; // iterations
const ARGON2_PARALLELISM = 1; // lanes

/** argon2id, as defined by the library's `Algorithm` enum. */
const ARGON2_ID = 2;

export function hashPassword(plaintext: string): Promise<string> {
  return hash(plaintext, {
    algorithm: ARGON2_ID,
    memoryCost: ARGON2_MEMORY_COST_KIB,
    timeCost: ARGON2_TIME_COST,
    parallelism: ARGON2_PARALLELISM,
  });
}

/**
 * Verifies a candidate password against a stored digest.
 *
 * Returns `false` rather than throwing on a malformed digest: a corrupt or
 * legacy hash in the database is an authentication failure, not a 500 that
 * tells the caller something interesting about the account.
 */
export async function verifyPassword(digest: string, candidate: string): Promise<boolean> {
  try {
    return await verify(digest, candidate);
  } catch {
    return false;
  }
}
