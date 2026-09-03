import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../store/authStore';
import { ApiError, apiRequest, bootstrapSession, signOut } from './client';

/**
 * The API client.
 *
 * This is the module that decides what happens when a token expires, and
 * getting it wrong is not a cosmetic failure: firing several refreshes at once
 * makes the server see a replayed refresh token and revoke every session, which
 * presents to the user as "the app randomly logs me out". These tests pin the
 * behaviour that prevents it.
 */

type FetchArgs = Parameters<typeof fetch>;

const API = 'http://api.test/api';

/** Builds a `Response` carrying the API's success envelope. */
function ok<T>(data: T, meta?: unknown): Response {
  return new Response(JSON.stringify({ success: true, data, meta }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function failure(status: number, code = 'UNAUTHENTICATED'): Response {
  return new Response(JSON.stringify({ success: false, error: { code, message: 'nope' } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

/** The URL of the nth call, so assertions can read as a sequence of requests. */
const urlOf = (call: FetchArgs): string => String(call[0]);

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  useAuthStore.setState({
    user: { id: 'u1', email: 'a@b.test', name: 'Ada', role: 'ADMIN', avatarUrl: null },
    accessToken: 'expired-token',
    status: 'authenticated',
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('apiRequest', () => {
  it('sends the access token and unwraps the envelope', async () => {
    fetchMock.mockResolvedValueOnce(ok({ id: 'svc-1' }));

    await expect(apiRequest('/services')).resolves.toEqual({ id: 'svc-1' });

    const [url, init] = fetchMock.mock.calls[0] as FetchArgs;
    expect(url).toBe(`${API}/services`);
    expect((init?.headers as Headers).get('Authorization')).toBe('Bearer expired-token');
    // Without this the refresh cookie is never sent and the session cannot be
    // restored on the next page load.
    expect(init?.credentials).toBe('include');
  });

  it('refreshes once and replays the original request on a 401', async () => {
    fetchMock
      .mockResolvedValueOnce(failure(401))
      .mockResolvedValueOnce(ok({ user: { id: 'u1' }, accessToken: 'fresh-token' }))
      .mockResolvedValueOnce(ok({ id: 'svc-1' }));

    await expect(apiRequest('/services')).resolves.toEqual({ id: 'svc-1' });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(urlOf(fetchMock.mock.calls[1] as FetchArgs)).toBe(`${API}/auth/refresh`);

    // The replay must carry the *new* token, not the one that just failed.
    const replay = fetchMock.mock.calls[2] as FetchArgs;
    expect((replay[1]?.headers as Headers).get('Authorization')).toBe('Bearer fresh-token');
  });

  it('refreshes only once when several requests expire together', async () => {
    /**
     * The scenario this exists for: every panel on the dashboard polls, the
     * token expires, and they all get a 401 in the same tick. Refresh tokens
     * are single-use and rotate, so a second concurrent refresh presents a
     * token the first already consumed — which the server correctly treats as
     * replay and answers by revoking the entire session family.
     */
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/auth/refresh')) {
        return Promise.resolve(ok({ user: { id: 'u1' }, accessToken: 'fresh-token' }));
      }
      return Promise.resolve(
        useAuthStore.getState().accessToken === 'fresh-token' ? ok({ url }) : failure(401),
      );
    });

    await Promise.all([apiRequest('/services'), apiRequest('/incidents'), apiRequest('/metrics')]);

    const refreshCalls = fetchMock.mock.calls.filter((call) =>
      urlOf(call as FetchArgs).endsWith('/auth/refresh'),
    );
    expect(refreshCalls).toHaveLength(1);
  });

  it('does not retry a second time if the replayed request also fails', async () => {
    fetchMock
      .mockResolvedValueOnce(failure(401))
      .mockResolvedValueOnce(ok({ user: { id: 'u1' }, accessToken: 'fresh-token' }))
      .mockResolvedValueOnce(failure(401));

    await expect(apiRequest('/services')).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('clears the session when the refresh itself is rejected', async () => {
    // The refresh token is gone, expired or revoked. This is a real sign-out.
    fetchMock.mockResolvedValueOnce(failure(401)).mockResolvedValueOnce(failure(401));

    await expect(apiRequest('/services')).rejects.toBeInstanceOf(ApiError);
    expect(useAuthStore.getState().status).toBe('anonymous');
    expect(useAuthStore.getState().accessToken).toBeNull();
  });

  it('never tries to refresh a failed refresh or login', async () => {
    // Otherwise a rejected sign-in recurses into itself.
    fetchMock.mockImplementation(() => Promise.resolve(failure(401)));

    await expect(apiRequest('/auth/login', { method: 'POST' })).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces the server error code and message', async () => {
    fetchMock.mockResolvedValueOnce(failure(409, 'CONFLICT'));

    await expect(apiRequest('/users/u2')).rejects.toMatchObject({
      status: 409,
      code: 'CONFLICT',
      message: 'nope',
    });
  });

  it('serialises a body and sets the content type only when there is one', async () => {
    // A fresh Response per call: a body can only be read once.
    fetchMock.mockImplementation(() => Promise.resolve(ok({})));

    await apiRequest('/incidents/i1', { method: 'PATCH', body: { status: 'RESOLVED' } });
    const [, withBody] = fetchMock.mock.calls[0] as FetchArgs;
    expect(withBody?.body).toBe('{"status":"RESOLVED"}');
    expect((withBody?.headers as Headers).get('Content-Type')).toBe('application/json');

    await apiRequest('/incidents');
    const [, withoutBody] = fetchMock.mock.calls[1] as FetchArgs;
    expect(withoutBody?.body).toBeUndefined();
    expect((withoutBody?.headers as Headers).get('Content-Type')).toBeNull();
  });

  it('handles a 204 that has no body to parse', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(apiRequest('/sessions')).resolves.toBeUndefined();
  });
});

describe('bootstrapSession', () => {
  it('restores a session from the refresh cookie', async () => {
    useAuthStore.setState({ user: null, accessToken: null, status: 'bootstrapping' });
    fetchMock.mockResolvedValueOnce(
      ok({ user: { id: 'u1', email: 'a@b.test', name: 'Ada', role: 'ADMIN' }, accessToken: 'tok' }),
    );

    await bootstrapSession();

    expect(useAuthStore.getState().status).toBe('authenticated');
    expect(useAuthStore.getState().accessToken).toBe('tok');
  });

  it('settles on anonymous rather than staying stuck when there is no cookie', async () => {
    // A visitor who is not signed in is the normal path, not an error — and if
    // the status never left `bootstrapping` the app would show the splash
    // forever.
    useAuthStore.setState({ user: null, accessToken: null, status: 'bootstrapping' });
    fetchMock.mockResolvedValueOnce(failure(401));

    await bootstrapSession();

    expect(useAuthStore.getState().status).toBe('anonymous');
  });

  it('settles on anonymous when the API is unreachable', async () => {
    useAuthStore.setState({ user: null, accessToken: null, status: 'bootstrapping' });
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    await bootstrapSession();

    expect(useAuthStore.getState().status).toBe('anonymous');
  });
});

describe('signOut', () => {
  it('revokes the session server-side and clears local state', async () => {
    fetchMock.mockResolvedValueOnce(ok({ revoked: true }));

    await signOut();

    expect(urlOf(fetchMock.mock.calls[0] as FetchArgs)).toBe(`${API}/auth/logout`);
    expect(useAuthStore.getState().status).toBe('anonymous');
  });

  it('still signs the user out when the request fails', async () => {
    // A network failure must not trap somebody in a session they asked to end.
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    await signOut();

    expect(useAuthStore.getState().status).toBe('anonymous');
  });
});
