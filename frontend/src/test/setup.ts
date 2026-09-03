import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { useAuthStore } from '../shared/store/authStore';

/**
 * Shared test setup.
 *
 * Two pieces of state outlive a test and have to be reset explicitly: the
 * rendered DOM, and the session store, which is a module-level singleton. A
 * leaked session is the worst kind of leak here, because it makes a test that
 * only passes when it runs second look like a test that passes.
 */
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useAuthStore.setState({ user: null, accessToken: null, status: 'bootstrapping' });
});
