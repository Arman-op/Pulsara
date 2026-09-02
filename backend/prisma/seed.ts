import 'dotenv/config';
import { PrismaClient, ProbeType, Role } from '@prisma/client';
import { z } from 'zod';
import { hashPassword } from '../src/modules/auth/password';

/**
 * Local development bootstrap.
 *
 * Creates the first administrator so somebody can sign in, and registers a
 * service catalogue with **real, reachable probe targets** derived from this
 * deployment's own configuration.
 *
 * What it deliberately does not do is fabricate observations. The original seed
 * invented six services with hard-coded uptime percentages and response times
 * ("Payment Processor", 99.95%, 150ms), five deployments with `Math.random()`
 * durations, and two incidents — and the dashboard rendered all of it as live
 * production data. Those services did not exist, so nothing could ever have
 * measured them.
 *
 * The catalogue below is different in kind: every entry is a real process this
 * stack actually runs, with an address the probe scheduler will genuinely
 * connect to. If one of them is down, the dashboard will say so, because it
 * checked. Operators register their own services through the API.
 */

const prisma = new PrismaClient();

const seedEnvSchema = z.object({
  SEED_ADMIN_EMAIL: z.string().email().toLowerCase(),
  SEED_ADMIN_NAME: z.string().min(1).default('Pulsara Administrator'),
  SEED_ADMIN_PASSWORD: z
    .string()
    .min(12, 'SEED_ADMIN_PASSWORD must be at least 12 characters')
    .refine((value) => value !== 'password', {
      message: 'SEED_ADMIN_PASSWORD must not be the literal string "password"',
    }),

  /** Used to derive the database probe target, so the two cannot disagree. */
  DATABASE_URL: z.string().url(),

  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  /** Origin the web client is served from, used as its probe target. */
  SEED_WEB_ORIGIN: z.string().url().default('http://localhost:5174'),
});

type SeedService = {
  name: string;
  description: string;
  probeType: ProbeType;
  probeTarget: string;
  probeIntervalSeconds: number;
  probeTimeoutMs: number;
  expectedStatusMin?: number;
  expectedStatusMax?: number;
};

/** Extracts `host:port` from a PostgreSQL connection string. */
function databaseAddress(databaseUrl: string): string {
  const parsed = new URL(databaseUrl);
  const port = parsed.port || '5432';
  return `${parsed.hostname}:${port}`;
}

function buildCatalogue(config: z.infer<typeof seedEnvSchema>): SeedService[] {
  return [
    {
      name: 'Pulsara API',
      description: 'This API. Probed through its own liveness endpoint.',
      probeType: ProbeType.HTTP,
      probeTarget: `http://localhost:${config.PORT}/api/health`,
      probeIntervalSeconds: 15,
      probeTimeoutMs: 3_000,
    },
    {
      name: 'Pulsara Database',
      description: 'PostgreSQL instance backing the API, probed at the TCP layer.',
      probeType: ProbeType.TCP,
      // Address comes from DATABASE_URL so the probe can never point somewhere
      // other than the database the application is actually using.
      probeTarget: databaseAddress(config.DATABASE_URL),
      probeIntervalSeconds: 30,
      probeTimeoutMs: 3_000,
    },
    {
      name: 'Pulsara Web',
      description: 'Web client origin. Reports OFFLINE when the dev server is not running.',
      probeType: ProbeType.HTTP,
      probeTarget: config.SEED_WEB_ORIGIN,
      probeIntervalSeconds: 30,
      probeTimeoutMs: 3_000,
      // A dev server answers 200; a static host may redirect.
      expectedStatusMin: 200,
      expectedStatusMax: 399,
    },
  ];
}

async function main(): Promise<void> {
  const parsed = seedEnvSchema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Seed configuration is invalid:\n${issues}`);
  }

  const config = parsed.data;

  // Every write is an upsert, so the seed is idempotent: rerunning it against a
  // populated database updates the bootstrap rows rather than failing on a
  // unique constraint or duplicating the catalogue.
  const admin = await prisma.user.upsert({
    where: { email: config.SEED_ADMIN_EMAIL },
    update: { name: config.SEED_ADMIN_NAME, role: Role.ADMIN, isActive: true },
    create: {
      email: config.SEED_ADMIN_EMAIL,
      name: config.SEED_ADMIN_NAME,
      passwordHash: await hashPassword(config.SEED_ADMIN_PASSWORD),
      role: Role.ADMIN,
    },
  });

  console.log(`Administrator ready: ${admin.email}`);

  const catalogue = buildCatalogue(config);

  for (const service of catalogue) {
    await prisma.service.upsert({
      where: { name: service.name },
      // Probe configuration is refreshed, but observed state is never touched:
      // status and the hysteresis counters belong to the scheduler.
      update: {
        description: service.description,
        probeType: service.probeType,
        probeTarget: service.probeTarget,
        probeIntervalSeconds: service.probeIntervalSeconds,
        probeTimeoutMs: service.probeTimeoutMs,
        ...(service.expectedStatusMin ? { expectedStatusMin: service.expectedStatusMin } : {}),
        ...(service.expectedStatusMax ? { expectedStatusMax: service.expectedStatusMax } : {}),
      },
      create: service,
    });
    console.log(`  registered ${service.name} -> ${service.probeType} ${service.probeTarget}`);
  }

  /**
   * The catalogue seeded before this change is left behind on an existing
   * database. Those rows describe services that never existed and can never be
   * probed, so they would sit at "not measured" forever.
   */
  const removed = await prisma.service.deleteMany({
    where: {
      name: {
        in: [
          'API Gateway',
          'Auth Service',
          'Payment Processor',
          'Background Workers',
          'Primary DB',
          'Primary Database',
          'Redis Cache',
        ],
      },
    },
  });

  if (removed.count > 0) {
    console.log(`Removed ${removed.count} fictional service(s) from the previous seed.`);
  }

  console.log(`Service catalogue ready: ${catalogue.length} services with live probe targets.`);
  console.log('Deployments and incidents are not seeded; they come from the CI integration');
  console.log('and the alerting engine respectively.');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error: unknown) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
