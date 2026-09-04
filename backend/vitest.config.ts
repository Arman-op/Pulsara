import { defineConfig } from 'vitest/config';

/**
 * Two suites, deliberately separated.
 *
 * `unit` covers pure decision logic and needs nothing but Node, so it runs in
 * milliseconds and can be the fast feedback loop and the first CI job.
 *
 * `integration` drives the real Express app against a real PostgreSQL database
 * over HTTP. It carries the database setup, which is why the split exists at
 * all: a contributor without Docker running can still run the unit suite.
 *
 * Integration files run one at a time. They truncate shared tables between
 * cases, so parallel files would delete each other's fixtures — and a suite
 * that fails only when the machine is busy is worse than a slow one.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/unit/**/*.test.ts'],
          setupFiles: ['tests/setup.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          include: ['tests/integration/**/*.test.ts'],
          setupFiles: ['tests/setup.ts'],
          globalSetup: ['tests/global-setup.ts'],
          // Applying migrations to a cold database takes longer than the default.
          hookTimeout: 120_000,
          testTimeout: 30_000,
        },
      },
    ],
    /**
     * Root-level, because Vitest does not honour it per project: integration
     * files truncate shared tables between cases, so running two at once would
     * have them deleting each other's fixtures.
     */
    fileParallelism: false,

    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      /**
       * Wiring and process lifecycle: exercised by starting the app, not by
       * asserting on it. Counting them would inflate the figure without testing
       * a decision.
       */
      exclude: ['src/server.ts', 'src/types/**', 'src/**/*.routes.ts'],
      reporter: ['text-summary', 'lcov'],

      /**
       * A floor, not a target.
       *
       * The numbers are set just under what the suite currently reaches, which
       * makes this a ratchet: a change that removes coverage fails, and a change
       * that adds it raises the bar for the next one. Set at an aspirational
       * figure instead, the threshold fails on unrelated work until somebody
       * lowers it, and lowering a threshold twice teaches everybody it means
       * nothing.
       *
       * It is also worth saying what this number is not. Coverage says a line
       * ran, not that anything checked what it did. The suite this guards asserts
       * behaviour against a real database precisely because a percentage cannot.
       */
      thresholds: {
        lines: 75,
        statements: 75,
        functions: 83,
        branches: 79,
      },
    },
  },
});
