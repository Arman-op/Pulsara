import type { HostSnapshot } from './host-collector';

/**
 * The most recent host sample, readable without holding a reference to the
 * collector.
 *
 * The collector is created in `server.ts` and owns its own timers; the scrape
 * endpoint is mounted in `app.ts` and has no way to reach it. Threading the
 * instance through the Express app to satisfy one read would put a lifecycle
 * concern into the request pipeline, so the latest reading lives here instead —
 * the same shape as the Prisma client and the logger, both of which are
 * process-wide singletons for the same reason.
 *
 * Reading the newest row from the database would be the alternative, and is
 * wrong for this purpose: samples are persisted as windowed means every thirty
 * seconds, so a scrape would report a value up to half a minute old and already
 * averaged. A Prometheus gauge is supposed to answer "what is it right now".
 */
let latest: HostSnapshot | null = null;

export function recordHostSnapshot(snapshot: HostSnapshot): void {
  latest = snapshot;
}

export function latestHostSnapshot(): HostSnapshot | null {
  return latest;
}

/** Test seam; the collector is the only writer in a running process. */
export function resetHostSnapshot(): void {
  latest = null;
}
