import jwt from 'jsonwebtoken';
import { MS_PER_MINUTE, MS_PER_SECOND } from '../../config/constants';
import { env, githubAuthMode } from '../../config/env';
import { UpstreamUnavailableError } from '../../lib/errors';
import { logger } from '../../lib/logger';

/**
 * Authentication to the GitHub API.
 *
 * Two mechanisms, and the choice between them is a real one — the tradeoff is
 * argued in ARCHITECTURE.md rather than here. What matters at this layer is
 * that both produce an `Authorization` header and nothing above needs to know
 * which one it got.
 *
 * The App path is two hops. A short-lived JWT signed with the App's private key
 * proves "I am this App"; exchanging it for an installation access token proves
 * "and I am acting for this installation". Only the second can read a
 * repository, and it lasts an hour, so it is cached and renewed rather than
 * minted per request.
 */

/**
 * GitHub rejects an App JWT whose `exp` is more than ten minutes out, and
 * clock skew between this host and GitHub is real. Nine minutes leaves room
 * for the drift without risking rejection.
 */
const APP_JWT_LIFETIME_MS = 9 * MS_PER_MINUTE;

/**
 * `iat` is backdated by a minute for the same reason. A host running slightly
 * fast produces a token GitHub considers issued in the future, and rejects.
 */
const APP_JWT_BACKDATE_MS = MS_PER_MINUTE;

/**
 * An installation token is valid for an hour. Renewing five minutes early means
 * a long sync started just before expiry does not fail halfway through.
 */
const TOKEN_RENEWAL_MARGIN_MS = 5 * MS_PER_MINUTE;

const API_VERSION = '2022-11-28';
const REQUEST_TIMEOUT_MS = 15_000;

type InstallationToken = { token: string; expiresAt: number };

let cachedToken: InstallationToken | null = null;

/**
 * Concurrent syncs would otherwise each mint a token, and GitHub invalidates
 * nothing when it issues another — so the waste is silent, which is worse than
 * loud. One in-flight request, shared.
 */
let inFlight: Promise<InstallationToken> | null = null;

/** Discovered once when GITHUB_APP_INSTALLATION_ID is not configured. */
let resolvedInstallationId: string | null = null;

/** Test seam; a running process holds one App identity for its lifetime. */
export function resetGitHubAuthCache(): void {
  cachedToken = null;
  inFlight = null;
  resolvedInstallationId = null;
}

function appCredentials(): { appId: string; privateKey: string } {
  const { GITHUB_APP_ID: appId, GITHUB_APP_PRIVATE_KEY: privateKey } = env;

  // The environment schema keeps these together, so one without the other
  // cannot reach this point.
  if (!appId || !privateKey) {
    throw new UpstreamUnavailableError('GitHub App credentials are not configured');
  }

  return { appId, privateKey };
}

/**
 * Signs the App JWT.
 *
 * RS256 with the App's private key: GitHub verifies it against the public key
 * it holds for the App, which is what makes this an assertion of identity
 * rather than a shared secret that has to be transmitted.
 */
function signAppJwt(): string {
  const { appId, privateKey } = appCredentials();
  const now = Date.now();

  try {
    return jwt.sign(
      {
        iat: Math.floor((now - APP_JWT_BACKDATE_MS) / MS_PER_SECOND),
        exp: Math.floor((now + APP_JWT_LIFETIME_MS) / MS_PER_SECOND),
        iss: appId,
      },
      privateKey,
      { algorithm: 'RS256' },
    );
  } catch (error) {
    /**
     * Almost always a malformed PEM — usually the `\n` escapes not having
     * survived whatever copied the key into the environment. Saying so beats
     * surfacing a library error about an unsupported key format.
     */
    throw new UpstreamUnavailableError(
      `The GitHub App private key could not be used to sign: ${
        error instanceof Error ? error.message : 'unknown error'
      }. Check that GITHUB_APP_PRIVATE_KEY is the full PEM, with newlines written as \\n.`,
    );
  }
}

async function githubRequest(
  path: string,
  appJwt: string,
  method: 'GET' | 'POST',
): Promise<Response> {
  try {
    return await fetch(`${env.GITHUB_API_URL}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${appJwt}`,
        'x-github-api-version': API_VERSION,
        'user-agent': 'Pulsara',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new UpstreamUnavailableError(
      error instanceof Error && error.name === 'TimeoutError'
        ? 'GitHub did not respond within the timeout'
        : 'GitHub could not be reached',
    );
  }
}

/**
 * Finds the installation to act as, when one was not configured.
 *
 * Refuses to guess between several. An App installed on two accounts that
 * silently picked the first would mirror the wrong organisation's pipelines and
 * look, from the dashboard, exactly like a repository that had gone quiet.
 */
async function discoverInstallationId(appJwt: string): Promise<string> {
  if (resolvedInstallationId) return resolvedInstallationId;

  const response = await githubRequest('/app/installations', appJwt, 'GET');

  if (!response.ok) {
    throw new UpstreamUnavailableError(
      `GitHub returned ${response.status} listing App installations; check GITHUB_APP_ID and the private key`,
    );
  }

  const installations = (await response.json()) as {
    id: number;
    account?: { login?: string };
  }[];

  if (installations.length === 0) {
    throw new UpstreamUnavailableError(
      'This GitHub App has no installations; install it on the account that owns the repository',
    );
  }

  if (installations.length > 1) {
    const options = installations
      .map((installation) => `${installation.id} (${installation.account?.login ?? 'unknown'})`)
      .join(', ');
    throw new UpstreamUnavailableError(
      `This GitHub App has several installations, so GITHUB_APP_INSTALLATION_ID must say which to use. Available: ${options}`,
    );
  }

  resolvedInstallationId = String(installations[0]?.id);
  logger.info({ installationId: resolvedInstallationId }, 'Discovered the GitHub App installation');
  return resolvedInstallationId;
}

async function mintInstallationToken(): Promise<InstallationToken> {
  const appJwt = signAppJwt();
  const installationId = env.GITHUB_APP_INSTALLATION_ID ?? (await discoverInstallationId(appJwt));

  const response = await githubRequest(
    `/app/installations/${installationId}/access_tokens`,
    appJwt,
    'POST',
  );

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new UpstreamUnavailableError(
      `GitHub returned ${response.status} issuing an installation token: ${detail.slice(0, 200)}`,
    );
  }

  const body = (await response.json()) as { token: string; expires_at: string };
  const expiresAt = new Date(body.expires_at).getTime();

  logger.debug(
    { installationId, expiresAt: body.expires_at },
    'Issued a GitHub installation token',
  );

  return {
    token: body.token,
    /**
     * Falls back to an hour from now if GitHub's timestamp is unparseable, so a
     * malformed response degrades to renewing on schedule rather than to
     * minting a token on every single request.
     */
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 60 * MS_PER_MINUTE,
  };
}

async function installationToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt - Date.now() > TOKEN_RENEWAL_MARGIN_MS) {
    return cachedToken.token;
  }

  inFlight ??= mintInstallationToken()
    .then((issued) => {
      cachedToken = issued;
      return issued;
    })
    .finally(() => {
      inFlight = null;
    });

  return (await inFlight).token;
}

/**
 * The `Authorization` header for a GitHub API request.
 *
 * Async because the App path may need a network round trip to renew its token.
 * The token path is synchronous in practice, and returning a promise for both
 * keeps every call site identical rather than branching on the mode.
 */
export async function githubAuthorization(): Promise<string> {
  switch (githubAuthMode) {
    case 'app':
      return `Bearer ${await installationToken()}`;
    case 'token':
      // Fine-grained PATs are also sent as Bearer; GitHub accepts `token` for
      // classic PATs too, but Bearer works for both and is the documented form.
      return `Bearer ${env.GITHUB_TOKEN ?? ''}`;
    case 'none':
      throw new UpstreamUnavailableError('GitHub integration is not configured');
  }
}
