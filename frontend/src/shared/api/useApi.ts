import * as React from 'react';
import { useAuthStore } from '../store/authStore';
import { ApiError, apiRequestWithMeta } from './client';

/**
 * Data fetching for a read endpoint.
 *
 * Every list view needs the same four states — loading, error, empty, loaded —
 * and getting any of them wrong is how a dashboard ends up showing stale or
 * invented data. Centralising the state machine means each screen decides how
 * to *render* those states rather than re-deriving them.
 *
 * This is deliberately a small hook rather than a query library. The app has a
 * handful of endpoints and no cross-screen cache sharing to speak of; adding
 * TanStack Query here would be more configuration than the problem needs.
 */

export type ApiState<T, M> = {
  data: T | null;
  meta: M | undefined;
  isLoading: boolean;
  error: string | null;
  /** Re-runs the request, e.g. after a mutation. */
  refresh: () => void;
};

export function useApi<T, M = Record<string, unknown>>(
  path: string | null,
  options?: { pollMs?: number },
): ApiState<T, M> {
  const [data, setData] = React.useState<T | null>(null);
  const [meta, setMeta] = React.useState<M | undefined>(undefined);
  const [isLoading, setIsLoading] = React.useState(path !== null);
  const [error, setError] = React.useState<string | null>(null);
  const [nonce, setNonce] = React.useState(0);

  const status = useAuthStore((store) => store.status);
  const pollMs = options?.pollMs;

  const refresh = React.useCallback(() => setNonce((value) => value + 1), []);

  React.useEffect(() => {
    // `null` is how a caller says "not yet"; it is not an error.
    if (path === null || status !== 'authenticated') return;

    const controller = new AbortController();
    let cancelled = false;

    const load = async () => {
      try {
        const result = await apiRequestWithMeta<T, M>(path, { signal: controller.signal });
        if (cancelled) return;
        setData(result.data);
        setMeta(result.meta);
        setError(null);
      } catch (caught) {
        if (cancelled || controller.signal.aborted) return;
        /**
         * A 401 that survives the client's refresh attempt means the session is
         * genuinely over; the auth store has already been cleared and the route
         * guard will redirect. Rendering "unauthenticated" as a red error box
         * on the way out is noise.
         */
        if (caught instanceof ApiError && caught.status === 401) return;
        setError(caught instanceof Error ? caught.message : 'Request failed');
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    void load();

    const timer = pollMs ? setInterval(() => void load(), pollMs) : null;

    return () => {
      cancelled = true;
      controller.abort();
      if (timer) clearInterval(timer);
    };
  }, [path, nonce, status, pollMs]);

  return { data, meta, isLoading, error, refresh };
}
