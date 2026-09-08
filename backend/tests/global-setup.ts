import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { testDatabaseUrl } from './test-env';

/**
 * Prepares the test database once, before any test file runs.
 *
 * The integration tests run against a real PostgreSQL instance rather than a
 * mock. Every interesting behaviour in this codebase lives in the database: the
 * partial unique index that deduplicates incidents, the serializable
 * transaction that stops the last administrator being demoted, the
 * compare-and-swap that makes refresh-token rotation safe under concurrency. A
 * mocked Prisma client would assert that the code calls the functions it calls,
 * and would pass just as happily with every one of those guarantees removed.
 *
 * Migrations are applied with `migrate deploy`, the same command production
 * uses, so a migration that only works when generated from a live schema fails
 * here rather than during a release.
 */

/** Connect to the maintenance database to create the test one if it is absent. */
async function ensureDatabaseExists(): Promise<void> {
  const target = new URL(testDatabaseUrl);
  const databaseName = target.pathname.replace(/^\//, '');

  const maintenance = new URL(testDatabaseUrl);
  maintenance.pathname = '/postgres';

  const client = new PrismaClient({ datasourceUrl: maintenance.toString() });

  try {
    const existing = await client.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) AS count FROM pg_database WHERE datname = ${databaseName}
    `;

    if (existing[0]?.count === 0n) {
      // CREATE DATABASE cannot run inside a transaction, and the name cannot be
      // parameterised. It comes from TEST_DATABASE_URL, and the quotes are
      // doubled so an identifier containing one cannot break out.
      await client.$executeRawUnsafe(`CREATE DATABASE "${databaseName.replace(/"/g, '""')}"`);
    }
  } finally {
    await client.$disconnect();
  }
}

export async function setup(): Promise<void> {
  await ensureDatabaseExists();

  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: testDatabaseUrl },
    stdio: 'inherit',
    // Windows resolves `npx` through the shell.
    shell: process.platform === 'win32',
  });
}
