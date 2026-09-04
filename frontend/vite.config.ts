import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * Vite configuration.
 *
 * The dev server port is pinned rather than left to Vite's "first free port"
 * behaviour: the API's CORS_ORIGINS allowlist names this exact origin, and a
 * server that silently moved to 5175 because 5174 was busy would fail every
 * credentialed request with an error that points at CORS rather than at the
 * port.
 */
const DEV_SERVER_PORT = 5174;

export default defineConfig({
  plugins: [react()],
  server: {
    port: DEV_SERVER_PORT,
    // Fail loudly instead of drifting to another port and breaking CORS.
    strictPort: true,
    host: true,
  },
  /**
   * Tests run in jsdom because every unit worth writing here involves rendering
   * or the browser's own `fetch`. `VITE_API_URL` is supplied explicitly rather
   * than read from a developer's `.env`: the client throws at import if it is
   * missing, and an assertion should never depend on a file that is not in the
   * repository.
   */
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    env: { VITE_API_URL: 'http://api.test' },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/main.tsx',
        'src/**/*.test.{ts,tsx}',
        'src/test/**',
        // Type declarations only. They compile away, so counting them measures
        // nothing and drags the figure down by a few hundred lines.
        'src/shared/api/types.ts',
        // Presentational primitives: a Card that renders its children has no
        // decision in it, and covering them would raise the number without
        // testing anything somebody could get wrong.
        'src/shared/components/{Badge,Button,Card,Drawer,Input,StatusDot,Table}.tsx',
      ],
      reporter: ['text-summary', 'lcov'],

      /**
       * A floor set just under what the suite reaches today, so it ratchets:
       * removing coverage fails, adding it raises the bar. An aspirational
       * threshold fails on unrelated work until somebody lowers it, and a
       * threshold lowered twice means nothing.
       *
       * Deliberately lower than the API's. The screens are mostly markup, and
       * the parts worth asserting — the request client, the route guard, the
       * rule that an unmeasured value renders as an em dash — are covered
       * directly rather than by chasing a percentage through JSX.
       */
      thresholds: {
        lines: 42,
        statements: 42,
        functions: 60,
        branches: 75,
      },
    },
  },

  build: {
    // Source maps are uploaded to the error tracker and are what make a
    // minified production stack trace readable.
    sourcemap: true,
    rollupOptions: {
      output: {
        /**
         * The Firebase SDK and the charting library together dominate the
         * bundle and change far less often than application code. Splitting
         * them into their own chunks means a routine UI change does not
         * invalidate roughly two thirds of a returning user's cache.
         */
        manualChunks: {
          firebase: ['firebase/app', 'firebase/auth'],
          charts: ['recharts'],
          vendor: ['react', 'react-dom', 'react-router-dom'],
        },
      },
    },
  },
});
