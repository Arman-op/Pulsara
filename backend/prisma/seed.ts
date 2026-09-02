import 'dotenv/config';
import { PrismaClient, Role } from '@prisma/client';
import { z } from 'zod';
import { hashPassword } from '../src/modules/auth/password';

/**
 * Local development bootstrap.
 *
 * This script exists to make a freshly created database usable: it creates the
 * first administrator so somebody can sign in, and registers the service
 * catalogue that the probe scheduler will monitor.
 *
 * What it deliberately does NOT do is fabricate observations. The previous seed
 * generated deployments, pipeline stages and incidents with `Math.random()`,
 * and the dashboard rendered them as live production data. Deployments come
 * from the CI provider and incidents are opened by the alerting engine from
 * real probe results; inventing either here would put fiction behind a UI whose
 * entire purpose is to be trusted during an outage.
 *
 * The catalogue below is configuration, not measurement. Health, uptime and
 * latency for these services are all measured at runtime.
 */

const prisma = new PrismaClient();

/**
 * Seed credentials are supplied by the environment so that no password is ever
 * committed, and so the same script can bootstrap a shared staging database
 * without that database's admin password living in git history.
 */
const seedEnvSchema = z.object({
  SEED_ADMIN_EMAIL: z.string().email().toLowerCase(),
  SEED_ADMIN_NAME: z.string().min(1).default('Pulsara Administrator'),
  SEED_ADMIN_PASSWORD: z
    .string()
    .min(12, 'SEED_ADMIN_PASSWORD must be at least 12 characters')
    .refine((value) => value !== 'password', {
      message: 'SEED_ADMIN_PASSWORD must not be the literal string "password"',
    }),
});

/**
 * The services this deployment is responsible for watching.
 *
 * Names and descriptions only. Every numeric field on `Service` is derived from
 * observations, so seeding one here would be seeding a lie.
 */
const SERVICE_CATALOGUE = [
  { name: 'API Gateway', description: 'Public edge that fronts every downstream service.' },
  { name: 'Auth Service', description: 'Issues and validates sessions for the platform.' },
  { name: 'Payment Processor', description: 'Handles checkout and settlement.' },
  { name: 'Background Workers', description: 'Asynchronous job queue consumers.' },
  { name: 'Primary Database', description: 'Primary PostgreSQL cluster.' },
  { name: 'Redis Cache', description: 'Shared cache and rate-limit counter store.' },
] as const;

async function main(): Promise<void> {
  const parsed = seedEnvSchema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Seed configuration is invalid:\n${issues}`);
  }

  const { SEED_ADMIN_EMAIL, SEED_ADMIN_NAME, SEED_ADMIN_PASSWORD } = parsed.data;

  /**
   * Upserts throughout: the seed is idempotent, so running it against a
   * database that already has data updates the bootstrap rows rather than
   * failing on a unique constraint or duplicating the catalogue.
   */
  const admin = await prisma.user.upsert({
    where: { email: SEED_ADMIN_EMAIL },
    update: { name: SEED_ADMIN_NAME, role: Role.ADMIN, isActive: true },
    create: {
      email: SEED_ADMIN_EMAIL,
      name: SEED_ADMIN_NAME,
      passwordHash: await hashPassword(SEED_ADMIN_PASSWORD),
      role: Role.ADMIN,
    },
  });

  console.log(`Administrator ready: ${admin.email}`);

  for (const service of SERVICE_CATALOGUE) {
    await prisma.service.upsert({
      where: { name: service.name },
      update: { description: service.description },
      create: { name: service.name, description: service.description },
    });
  }

  console.log(`Service catalogue ready: ${SERVICE_CATALOGUE.length} services`);
  console.log('Deployments and incidents are intentionally not seeded; they arrive from');
  console.log('the CI integration and the alerting engine respectively.');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error: unknown) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
