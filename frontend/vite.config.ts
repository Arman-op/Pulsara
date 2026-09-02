import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

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
