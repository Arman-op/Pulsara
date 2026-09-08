import { env } from '../../config/env';
import { useAuthStore } from '../store/authStore';
import type { ApiFailure, ApiResponse, AuthUser } from './types';

/**
 * The single way this application talks to the API.
 *
 * Components previously called `fetch` directly with a hand-assembled
 * `Authorization` header and an `import.meta.env.VITE_API_URL || 'localhost'`
 * fallback, in six different places. That left no shared place to handle token
 * expiry, so a 15-minute-old tab simply started failing.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  readonly requestId: string | undefined;

  constructor(status: number, failure: ApiFailure['error']) {
    super(failure.message);
    this.name = 'ApiError';
    this.status = status;
    this.code = failure.code;
    this.details = failure.details;
    this.requestId = failure.requestId;
  }
}

/** Endpoints that must not trigger a refresh attempt, to avoid recursion. */
const NO_REFRESH_PATHS = new Set(['/auth/refresh', '/auth/login', '/auth/firebase']);

/**
 * In-flight refresh, shared by every caller.
 *
 * When a token expires, every panel on the dashboard gets a 401 within
 * milliseconds of each other. Without this, each would fire its own refresh —
 * and because refresh tokens are single-use and rotate, the second request
 * would present a token the first had already consumed, which the server
 * correctly treats as replay and answers by revoking every session. Chasing
 * that symptom ("the app randomly logs me out") is how single-flight refresh
 * gets discovered the hard way.
 */
let refreshInFlight: Promise<boolean> | null = null;

async function performRefresh(): Promise<boolean> {
  const response = await fetch(`${env.VITE_API_URL}/api/auth/refresh`, {
    method: 'POST',
    // Sends the HttpOnly refresh cookie; without this the request is anonymous.
    credentials: 'include',
  });

  if (!response.ok) return false;

  const body = (await response.json()) as ApiResponse<{ user: AuthUser; accessToken: string }>;
  if (!body.success) return false;

  useAuthStore.getState().setSession(body.data.user, body.data.accessToken);
  return true;
}

function refreshSession(): Promise<boolean> {
  refreshInFlight ??= performRefresh()
    .catch(() => false)
    .finally(() => {
      refreshInFlight = null;
    });
  return refreshInFlight;
}

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
};

async function send(
  path: string,
  options: RequestOptions,
  token: string | null,
): Promise<Response> {
  const headers = new Headers();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');

  return fetch(`${env.VITE_API_URL}/api${path}`, {
    method: options.method ?? 'GET',
    headers,
    credentials: 'include',
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

/**
 * Performs a request, transparently refreshing an expired access token once.
 *
 * Throws `ApiError` on a failure response so callers use one `try`/`catch`
 * rather than checking `res.ok` and then `body.success` separately.
 */
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { accessToken } = useAuthStore.getState();
  let response = await send(path, options, accessToken);

  if (response.status === 401 && !NO_REFRESH_PATHS.has(path)) {
    const refreshed = await refreshSession();

    if (refreshed) {
      response = await send(path, options, useAuthStore.getState().accessToken);
    } else {
      // The refresh token is gone, expired or revoked. This is a real sign-out,
      // not a transient error.
      useAuthStore.getState().clearSession();
    }
  }

  // 204 has no body to parse.
  if (response.status === 204) return undefined as T;

  const body = (await response.json()) as ApiResponse<T>;

  if (!response.ok || !body.success) {
    const failure: ApiFailure['error'] = body.success
      ? { code: 'UNKNOWN', message: response.statusText }
      : body.error;
    throw new ApiError(response.status, failure);
  }

  return body.data;
}

/**
 * As `apiRequest`, but also returns the envelope's `meta`.
 *
 * List endpoints carry pagination totals and, more importantly here,
 * configuration facts like `connectedRepositories` that let the UI tell an
 * unconfigured integration apart from an empty one.
 */
export async function apiRequestWithMeta<T, M = Record<string, unknown>>(
  path: string,
  options: RequestOptions = {},
): Promise<{ data: T; meta: M | undefined }> {
  const { accessToken } = useAuthStore.getState();
  let response = await send(path, options, accessToken);

  if (response.status === 401 && !NO_REFRESH_PATHS.has(path)) {
    if (await refreshSession()) {
      response = await send(path, options, useAuthStore.getState().accessToken);
    } else {
      useAuthStore.getState().clearSession();
    }
  }

  const body = (await response.json()) as ApiResponse<T>;

  if (!response.ok || !body.success) {
    const failure: ApiFailure['error'] = body.success
      ? { code: 'UNKNOWN', message: response.statusText }
      : body.error;
    throw new ApiError(response.status, failure);
  }

  return { data: body.data, meta: body.meta as M | undefined };
}

/**
 * Restores a session on page load from the HttpOnly refresh cookie.
 *
 * Called once at start-up. Failure is the normal path for a visitor who is not
 * signed in, so it resolves rather than throwing.
 */
export async function bootstrapSession(): Promise<void> {
  const restored = await refreshSession();
  if (!restored) useAuthStore.getState().markAnonymous();
}

/** Signs out: revokes the refresh token server-side, then clears local state. */
export async function signOut(): Promise<void> {
  try {
    await fetch(`${env.VITE_API_URL}/api/auth/logout`, {
      method: 'POST',
      credentials: 'include',
    });
  } catch {
    // A network failure must not trap the user in a session they asked to end.
  } finally {
    useAuthStore.getState().clearSession();
  }
}
