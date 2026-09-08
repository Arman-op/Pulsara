import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { githubAuthorization, resetGitHubAuthCache } from '../../src/modules/github/github.auth';

/**
 * GitHub App authentication.
 *
 * The App path is two hops: a short-lived JWT signed with the App's private key
 * proves "I am this App", and exchanging it proves "and I am acting for this
 * installation". Only the second can read a repository.
 *
 * The properties worth pinning are the ones whose failure is silent. A JWT with
 * a bad `iat` is rejected by GitHub in a way that looks like a bad key; a token
 * minted per request wastes nothing visible and so is never noticed; and a
 * concurrent renewal is the sort of thing that only shows up under load.
 *
 * `vi.hoisted` sets the credentials before this file's imports, because
 * `src/config/env.ts` reads and freezes the environment at import time.
 */

const { PUBLIC_KEY, APP_ID } = vi.hoisted(() => {
  /**
   * `require` rather than an import: a hoisted block runs before this file's
   * imports are initialised, so an imported binding is not yet in scope here.
   */
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { generateKeyPairSync } = require('node:crypto') as typeof import('node:crypto');

  // A real RSA pair, so the JWT is genuinely verifiable rather than merely
  // asserted to have the right shape.
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const appId = '123456';
  process.env.GITHUB_APP_ID = appId;
  // Stored the way a secret store carries it: newlines as literal backslash-n.
  process.env.GITHUB_APP_PRIVATE_KEY = privateKey.replace(/\n/g, '\\n');
  process.env.GITHUB_APP_INSTALLATION_ID = '777';
  delete process.env.GITHUB_TOKEN;

  return { PUBLIC_KEY: publicKey, APP_ID: appId };
});

/** Captures the App JWT each request was signed with. */
let presentedJwts: string[] = [];
let fetchMock: ReturnType<typeof vi.fn>;

function tokenResponse(token: string, expiresInMinutes: number): Response {
  return new Response(
    JSON.stringify({
      token,
      expires_at: new Date(Date.now() + expiresInMinutes * 60_000).toISOString(),
    }),
    { status: 201, headers: { 'content-type': 'application/json' } },
  );
}

beforeEach(() => {
  resetGitHubAuthCache();
  presentedJwts = [];

  fetchMock = vi.fn((_url: string, init?: RequestInit) => {
    const authorization = (init?.headers as Record<string, string> | undefined)?.authorization;
    presentedJwts.push((authorization ?? '').replace('Bearer ', ''));
    return Promise.resolve(tokenResponse('ghs_installation_token', 60));
  });

  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetGitHubAuthCache();
});

describe('the App JWT', () => {
  it('is signed with RS256 and verifies against the App public key', async () => {
    await githubAuthorization();

    const presented = presentedJwts[0];
    expect(presented).toBeTruthy();

    // Verifying rather than decoding: a token that merely parses proves nothing.
    const claims = jwt.verify(presented ?? '', PUBLIC_KEY, { algorithms: ['RS256'] });
    expect(typeof claims).toBe('object');
    expect((claims as jwt.JwtPayload).iss).toBe(APP_ID);
  });

  it('backdates iat and expires within GitHub ten-minute ceiling', async () => {
    /**
     * Both bounds are real rejections, not theory. A host running slightly fast
     * produces a token GitHub considers issued in the future; an `exp` beyond
     * ten minutes is refused outright. Either surfaces as an authentication
     * failure that looks exactly like a bad private key.
     */
    await githubAuthorization();

    const claims = jwt.decode(presentedJwts[0] ?? '') as jwt.JwtPayload;
    const now = Math.floor(Date.now() / 1000);

    expect(claims.iat).toBeLessThan(now);
    expect(claims.exp).toBeGreaterThan(now);
    expect((claims.exp ?? 0) - now).toBeLessThanOrEqual(600);
  });
});

describe('the installation token', () => {
  it('is what ends up on the request, not the App JWT', async () => {
    // The App JWT cannot read a repository; only the installation token can.
    expect(await githubAuthorization()).toBe('Bearer ghs_installation_token');
  });

  it('is requested from the configured installation', async () => {
    await githubAuthorization();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/app/installations/777/access_tokens');
  });

  it('is cached rather than minted per request', async () => {
    await githubAuthorization();
    await githubAuthorization();
    await githubAuthorization();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('is renewed before it expires, not after', async () => {
    /**
     * Renewing exactly at expiry means a sync that starts a second earlier
     * fails partway through. A token inside the renewal margin is treated as
     * already spent.
     */
    fetchMock.mockImplementationOnce(() => Promise.resolve(tokenResponse('nearly_expired', 2)));

    expect(await githubAuthorization()).toBe('Bearer nearly_expired');
    expect(await githubAuthorization()).toBe('Bearer ghs_installation_token');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('mints once when several requests renew at the same moment', async () => {
    // GitHub invalidates nothing when it issues another token, so duplicate
    // minting is waste that never announces itself.
    await Promise.all([githubAuthorization(), githubAuthorization(), githubAuthorization()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failure', async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(new Response('{"message":"Bad credentials"}', { status: 401 })),
    );

    await expect(githubAuthorization()).rejects.toThrow(/401/);

    // The next attempt must try again rather than replay the rejection.
    expect(await githubAuthorization()).toBe('Bearer ghs_installation_token');
  });

  it('reports an unreachable GitHub rather than hanging the sync', async () => {
    fetchMock.mockImplementationOnce(() => Promise.reject(new TypeError('network down')));
    await expect(githubAuthorization()).rejects.toThrow(/could not be reached/i);
  });
});
