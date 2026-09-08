import { timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { env } from '../../config/env';
import { UnauthenticatedError } from '../../lib/errors';
import { expositionContentType, renderMetrics } from './prometheus';

/**
 * The scrape endpoint.
 *
 * Deliberately not under `/api`, and deliberately not wrapped in the JSON
 * envelope every other route uses. `/metrics` is where every Prometheus
 * installation looks by default, and the response is a text format with its own
 * content type — a scraper handed `{"success":true,"data":"..."}` would simply
 * fail to parse it.
 *
 * It is also outside the session middleware. A scraper is not a user: it holds
 * no cookie, cannot refresh a token, and would report the service down every
 * time the signing key rotated.
 */

const BEARER_PREFIX = 'Bearer ';

/**
 * Optional shared-secret check.
 *
 * Unset is a legitimate configuration — the usual deployment keeps this port on
 * an internal network where the scraper lives. Where it is exposed, the token
 * matters: the response names every monitored service, reports host saturation
 * and counts open incidents, which together describe the shape and the current
 * weak points of the deployment to anyone who asks.
 */
function authorizeScrape(req: Request): void {
  const expected = env.METRICS_SCRAPE_TOKEN;
  if (!expected) return;

  const header = req.headers.authorization;
  if (!header?.startsWith(BEARER_PREFIX)) {
    throw new UnauthenticatedError('Metrics scraping requires a bearer token');
  }

  const presented = Buffer.from(header.slice(BEARER_PREFIX.length), 'utf8');
  const secret = Buffer.from(expected, 'utf8');

  // Length is compared first because timingSafeEqual throws on a mismatch, and
  // both paths must reject identically.
  if (presented.length !== secret.length || !timingSafeEqual(presented, secret)) {
    throw new UnauthenticatedError('Metrics scraping token is not valid');
  }
}

export async function scrape(req: Request, res: Response): Promise<void> {
  authorizeScrape(req);

  const body = await renderMetrics();

  res.setHeader('Content-Type', expositionContentType());
  /**
   * A scrape is a point-in-time reading. Any cache between the scraper and this
   * process would turn a stalled exporter into a series that looks alive.
   */
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send(body);
}
