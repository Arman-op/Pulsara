import { env } from '../../config/env';
import { UpstreamUnavailableError } from '../../lib/errors';
import { logger } from '../../lib/logger';

/**
 * Minimal GitHub REST client.
 *
 * Only the two endpoints Pulsara needs are implemented, so there is no
 * dependency on a large SDK for two calls. What the client does carry is the
 * behaviour that matters against a rate-limited API: conditional requests,
 * rate-limit awareness and a bounded timeout.
 */

/** GitHub requires an explicit API version header. */
const API_VERSION = '2022-11-28';

/** Beyond this, a hung upstream would stall the sync loop. */
const REQUEST_TIMEOUT_MS = 15_000;

const RATE_LIMIT_REMAINING_HEADER = 'x-ratelimit-remaining';
const RATE_LIMIT_RESET_HEADER = 'x-ratelimit-reset';

export type GitHubWorkflowRun = {
  id: number;
  name: string | null;
  head_branch: string | null;
  head_sha: string;
  event: string;
  /** queued | in_progress | completed */
  status: string | null;
  /** success | failure | cancelled | skipped | timed_out | action_required */
  conclusion: string | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  run_started_at: string | null;
  actor: { login: string; avatar_url: string } | null;
  head_commit: { message: string } | null;
  repository?: { full_name: string };
};

export type GitHubWorkflowJob = {
  id: number;
  run_id: number;
  name: string;
  status: string | null;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  html_url: string | null;
};

/**
 * A conditional response.
 *
 * `notModified` is distinct from an empty result. GitHub does not charge a 304
 * against the rate limit, so replaying the stored ETag makes a frequent poll
 * nearly free — but only if the caller can tell "nothing changed" apart from
 * "there is nothing".
 */
export type ConditionalResult<T> =
  | { notModified: true }
  | { notModified: false; data: T; etag: string | null };

function authHeaders(): Record<string, string> {
  if (!env.GITHUB_TOKEN) {
    throw new UpstreamUnavailableError('GitHub integration is not configured');
  }
  return {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${env.GITHUB_TOKEN}`,
    'x-github-api-version': API_VERSION,
    'user-agent': 'Pulsara',
  };
}

async function request(path: string, etag?: string | null): Promise<Response> {
  const headers = new Headers(authHeaders());
  if (etag) headers.set('if-none-match', etag);

  let response: Response;
  try {
    response = await fetch(`${env.GITHUB_API_URL}${path}`, {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new UpstreamUnavailableError(
      error instanceof Error && error.name === 'TimeoutError'
        ? 'GitHub did not respond within the timeout'
        : 'GitHub could not be reached',
    );
  }

  const remaining = Number(response.headers.get(RATE_LIMIT_REMAINING_HEADER));
  if (Number.isFinite(remaining) && remaining < 100) {
    const resetAt = Number(response.headers.get(RATE_LIMIT_RESET_HEADER));
    logger.warn(
      { remaining, resetAt: Number.isFinite(resetAt) ? new Date(resetAt * 1000) : null },
      'GitHub rate limit budget is running low',
    );
  }

  return response;
}

async function readError(response: Response): Promise<string> {
  const body = await response.text().catch(() => '');
  // GitHub returns a JSON body with a message; fall back to the status text.
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && 'message' in parsed) {
      // The `in` check above already narrows `parsed` to carry `message`.
      const { message } = parsed;
      if (typeof message === 'string') return message;
    }
  } catch {
    /* fall through to the status text */
  }
  return response.statusText;
}

/**
 * Lists recent workflow runs for a repository.
 *
 * Deliberately not paginated beyond the first page. Pulsara mirrors *recent*
 * delivery activity; walking a repository's entire history on every sync would
 * spend the rate limit on data nobody is looking at. History accumulates
 * naturally as runs arrive.
 */
export async function listWorkflowRuns(
  owner: string,
  repo: string,
  perPage: number,
  etag?: string | null,
): Promise<ConditionalResult<GitHubWorkflowRun[]>> {
  const response = await request(`/repos/${owner}/${repo}/actions/runs?per_page=${perPage}`, etag);

  if (response.status === 304) return { notModified: true };

  if (!response.ok) {
    throw new UpstreamUnavailableError(
      `GitHub returned ${response.status} listing runs for ${owner}/${repo}: ${await readError(response)}`,
    );
  }

  const body = (await response.json()) as { workflow_runs?: GitHubWorkflowRun[] };

  return {
    notModified: false,
    data: body.workflow_runs ?? [],
    etag: response.headers.get('etag'),
  };
}

/** Lists the jobs belonging to one workflow run. */
export async function listRunJobs(
  owner: string,
  repo: string,
  runId: string,
): Promise<GitHubWorkflowJob[]> {
  const response = await request(`/repos/${owner}/${repo}/actions/runs/${runId}/jobs?per_page=100`);

  if (!response.ok) {
    throw new UpstreamUnavailableError(
      `GitHub returned ${response.status} listing jobs for run ${runId}: ${await readError(response)}`,
    );
  }

  const body = (await response.json()) as { jobs?: GitHubWorkflowJob[] };
  return body.jobs ?? [];
}

/** Confirms a repository exists and the token can read it. */
export async function getRepository(
  owner: string,
  repo: string,
): Promise<{ id: number; full_name: string; default_branch: string }> {
  const response = await request(`/repos/${owner}/${repo}`);

  if (!response.ok) {
    throw new UpstreamUnavailableError(
      `GitHub returned ${response.status} for ${owner}/${repo}: ${await readError(response)}`,
    );
  }

  return (await response.json()) as { id: number; full_name: string; default_branch: string };
}
