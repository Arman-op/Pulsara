import 'dotenv/config';
import { z } from 'zod';

/**
 * Runtime environment contract.
 *
 * Every environment-specific value the server depends on is declared here and
 * validated once, at process start, before any listener is bound. A missing or
 * malformed variable crashes the process with an actionable message rather than
 * surfacing as a confusing runtime failure under load.
 *
 * Rules:
 *  - No secret has a fallback value. A default secret is worse than no secret,
 *    because it silently ships to production and looks configured.
 *  - Non-secret operational tuning knobs do carry defaults, so a developer only
 *    has to supply what is genuinely environment-specific.
 */

const NODE_ENV_VALUES = ['development', 'test', 'production'] as const;
const LOG_LEVEL_VALUES = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;

/** Minimum entropy we accept for an HMAC signing key, in characters. */
const MIN_SECRET_LENGTH = 32;

/**
 * Signing keys that have appeared in this repository's history or in common
 * tutorials. Rejecting them by name stops a copy-pasted placeholder from ever
 * being mistaken for a real secret.
 */
const FORBIDDEN_SECRETS = new Set([
  'your_jwt_secret',
  'your_refresh_secret',
  'production_secret_change_me',
  'changeme',
  'secret',
]);

const secret = (label: string) =>
  z
    .string({ required_error: `${label} is required` })
    .min(MIN_SECRET_LENGTH, `${label} must be at least ${MIN_SECRET_LENGTH} characters`)
    .refine((value) => !FORBIDDEN_SECRETS.has(value.toLowerCase()), {
      message: `${label} is a known placeholder value and must be replaced`,
    });

/** Parses a comma-separated list into a trimmed, non-empty array. */
const csv = z.string().transform((value, ctx) => {
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (items.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must contain at least one entry' });
    return z.NEVER;
  }
  return items;
});

/** Coerces a numeric string, rejecting NaN rather than silently defaulting. */
const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

const envSchema = z.object({
  NODE_ENV: z.enum(NODE_ENV_VALUES).default('development'),
  PORT: int(1, 65535).default(4000),
  LOG_LEVEL: z.enum(LOG_LEVEL_VALUES).default('info'),

  /** PostgreSQL connection string consumed by Prisma. */
  DATABASE_URL: z.string().url().startsWith('postgres', 'DATABASE_URL must be a PostgreSQL URL'),

  /** Browser origins permitted by CORS and by the Socket.IO handshake. */
  CORS_ORIGINS: csv,

  JWT_ACCESS_SECRET: secret('JWT_ACCESS_SECRET'),
  JWT_REFRESH_SECRET: secret('JWT_REFRESH_SECRET'),
  ACCESS_TOKEN_TTL_SECONDS: int(60, 60 * 60 * 24).default(900),
  REFRESH_TOKEN_TTL_DAYS: int(1, 90).default(7),

  RATE_LIMIT_WINDOW_MS: int(1_000, 60 * 60 * 1000).default(60_000),
  RATE_LIMIT_MAX_REQUESTS: int(1, 100_000).default(300),

  /**
   * A much tighter budget for credential endpoints. Sized for a human who
   * mistypes a password, not for a client polling a dashboard.
   */
  AUTH_RATE_LIMIT_WINDOW_MS: int(1_000, 60 * 60 * 1000).default(900_000),
  AUTH_RATE_LIMIT_MAX_ATTEMPTS: int(1, 1_000).default(10),

  /**
   * Federated sign-in via Firebase is optional. The three credential fields
   * are all-or-nothing: a partial configuration is a mistake, and treating it
   * as "disabled" would hide a broken production deployment behind a working
   * password form.
   */
  FIREBASE_PROJECT_ID: z.string().min(1).optional(),
  FIREBASE_CLIENT_EMAIL: z.string().email().optional(),
  /**
   * PEM private key. Secret stores and `.env` files cannot carry raw
   * newlines, so the key is supplied with literal backslash-n sequences and
   * expanded back into real newlines here before the PEM is parsed.
   */
  FIREBASE_PRIVATE_KEY: z
    .string()
    .min(1)
    .optional()
    .transform((value) => value?.replace(/\\n/g, '\n')),
});

/**
 * Cross-field rules that cannot be expressed on an individual property.
 */
const validatedEnvSchema = envSchema
  .refine((value) => value.JWT_ACCESS_SECRET !== value.JWT_REFRESH_SECRET, {
    path: ['JWT_REFRESH_SECRET'],
    message:
      'JWT_REFRESH_SECRET must differ from JWT_ACCESS_SECRET, otherwise a refresh token can be replayed as an access token',
  })
  .refine(
    (value) => {
      const provided = [
        value.FIREBASE_PROJECT_ID,
        value.FIREBASE_CLIENT_EMAIL,
        value.FIREBASE_PRIVATE_KEY,
      ].filter(Boolean).length;
      return provided === 0 || provided === 3;
    },
    {
      path: ['FIREBASE_PROJECT_ID'],
      message:
        'Firebase sign-in requires FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY together, or none of them',
    },
  );

export type Env = z.infer<typeof validatedEnvSchema>;

/**
 * Formats a Zod failure as a flat, greppable list. Startup errors are read in a
 * container log, so one variable per line beats a nested JSON dump.
 */
function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
}

function loadEnv(): Env {
  const parsed = validatedEnvSchema.safeParse(process.env);

  if (!parsed.success) {
    process.stderr.write(
      `\nPulsara API cannot start: invalid environment configuration.\n\n` +
        `${formatIssues(parsed.error)}\n\n` +
        `See backend/.env.example for the full list of variables and how to generate secrets.\n\n`,
    );
    process.exit(1);
  }

  return parsed.data;
}

export const env = loadEnv();

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

/** Whether federated sign-in is configured for this deployment. */
export const isFirebaseConfigured = Boolean(
  env.FIREBASE_PROJECT_ID && env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY,
);
