import { prisma } from '../../src/db/prisma';

/**
 * Test isolation.
 *
 * Every case starts from an empty database. The alternative — sharing fixtures
 * across cases and cleaning up what you created — produces suites where a
 * failure in one test cascades into unrelated ones, and where test order
 * silently becomes part of the contract.
 *
 * `TRUNCATE ... RESTART IDENTITY CASCADE` in a single statement is
 * substantially faster than deleting per table, and CASCADE means the tables
 * do not have to be listed in foreign-key order.
 */

/** Tables Prisma owns. `_prisma_migrations` is deliberately excluded. */
const TABLES = [
  'AuditLog',
  'IncidentEvent',
  'Incident',
  'Stage',
  'Deployment',
  'RepoConnection',
  'Metric',
  'ProbeResult',
  'Service',
  'RefreshToken',
  'User',
] as const;

export async function resetDatabase(): Promise<void> {
  const quoted = TABLES.map((table) => `"public"."${table}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`);
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
