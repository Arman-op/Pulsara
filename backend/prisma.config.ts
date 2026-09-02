import path from 'node:path';
import 'dotenv/config';
import { defineConfig } from 'prisma/config';

/**
 * Prisma CLI configuration.
 *
 * Replaces the deprecated `package.json#prisma` key. Unlike the CLI's implicit
 * behaviour, this file does not load `.env` on its own, so dotenv is imported
 * explicitly above to keep `DATABASE_URL` available to `migrate` and `seed`.
 */
export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  migrations: {
    seed: 'tsx prisma/seed.ts',
  },
});
