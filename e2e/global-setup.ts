import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { e2eConfig } from './playwright.config';

/**
 * Prepares a database of its own, seeded through the real bootstrap path.
 *
 * Everything here runs inside the backend package rather than importing Prisma
 * into this one. That is not a workaround: the generated client belongs to the
 * schema it was generated from, and giving these tests a second copy would mean
 * a schema change could leave the browser suite talking to a client that no
 * longer matches the database it is testing.
 *
 * The account and the service catalogue come from `prisma/seed.ts` — the same
 * script a developer runs — so this suite exercises the bootstrap somebody
 * actually performs rather than a private arrangement that only exists here.
 */

const BACKEND = fileURLToPath(new URL('../backend', import.meta.url));

function inBackend(command: string, args: string[], extraEnv: Record<string, string> = {}): void {
  execFileSync(command, args, {
    cwd: BACKEND,
    env: { ...process.env, DATABASE_URL: e2eConfig.DATABASE_URL, ...extraEnv },
    stdio: 'inherit',
    // Windows resolves npx through the shell.
    shell: process.platform === 'win32',
  });
}

/**
 * Runs a snippet against the e2e database using the backend's own client.
 *
 * Two things here are deliberate, and both were bugs first.
 *
 * It does not go through `npx`. On Windows `npx` is a `.cmd`, which Node will
 * only spawn through a shell — and with `shell: true` Node joins the arguments
 * into one command string without quoting them. A multi-line snippet then stops
 * being a single argument and becomes several commands, the first nonsense and
 * the rest silently discarded. It failed quietly: the setup reported success,
 * nothing was truncated, and the assertion about an empty incident feed passed
 * only for as long as the database happened to be new. Spawning
 * `process.execPath` — the Node binary — needs no shell at all.
 *
 * And the snippet goes to a file rather than to `--eval`, because eval'd input
 * is CommonJS, which rejects the top-level `await` every one of these needs.
 * The file lives in the backend package so that `@prisma/client` resolves, and
 * is removed whether or not the script succeeded.
 */
const TSX = path.join(BACKEND, 'node_modules', 'tsx', 'dist', 'cli.mjs');

function runScript(script: string): void {
  const file = path.join(BACKEND, `.e2e-setup-${process.pid}.mts`);
  writeFileSync(file, script, 'utf8');
  try {
    execFileSync(process.execPath, [TSX, file], {
      cwd: BACKEND,
      env: { ...process.env, DATABASE_URL: e2eConfig.DATABASE_URL },
      stdio: 'inherit',
    });
  } finally {
    rmSync(file, { force: true });
  }
}

const CREATE_DATABASE = `
  import { PrismaClient } from '@prisma/client';
  const target = new URL(process.env.DATABASE_URL);
  const name = target.pathname.replace(/^\\//, '');
  const maintenance = new URL(process.env.DATABASE_URL);
  maintenance.pathname = '/postgres';
  const client = new PrismaClient({ datasourceUrl: maintenance.toString() });
  const rows = await client.$queryRaw\`SELECT count(*)::int AS count FROM pg_database WHERE datname = \${name}\`;
  if (rows[0].count === 0) await client.$executeRawUnsafe(\`CREATE DATABASE "\${name}"\`);
  await client.$disconnect();
`;

/**
 * A clean slate each run. A failed run must not leave state behind that makes
 * the next one pass for the wrong reason — an incident from a previous attempt
 * would quietly satisfy an assertion about an empty feed.
 */
const TRUNCATE = `
  import { PrismaClient } from '@prisma/client';
  const prisma = new PrismaClient();
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "AuditLog", "IncidentEvent", "Incident", "Stage", "Deployment", "RepoConnection", "Metric", "ProbeResult", "Service", "RefreshToken", "User" RESTART IDENTITY CASCADE');
  await prisma.$disconnect();
`;

export default function globalSetup(): void {
  runScript(CREATE_DATABASE);
  inBackend('npx', ['prisma', 'migrate', 'deploy']);
  runScript(TRUNCATE);

  inBackend('npm', ['run', 'db:seed'], {
    SEED_ADMIN_EMAIL: e2eConfig.ADMIN_EMAIL,
    SEED_ADMIN_NAME: 'End To End',
    SEED_ADMIN_PASSWORD: e2eConfig.ADMIN_PASSWORD,
    SEED_WEB_ORIGIN: e2eConfig.WEB_URL,
  });
}
