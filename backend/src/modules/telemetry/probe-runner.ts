import { connect } from 'node:net';
import { ProbeType, type Service } from '@prisma/client';

/**
 * Executes a single reachability check.
 *
 * The result of this function is the only evidence Pulsara has that a service
 * is up. Everything downstream — status, uptime percentage, latency, incidents
 * — is derived from a stream of these, so it deliberately reports what it
 * observed and never guesses.
 */

export type ProbeOutcome = {
  ok: boolean;
  /** Round-trip time in milliseconds; null when no connection was established. */
  latencyMs: number | null;
  /** HTTP status observed, for HTTP probes only. */
  statusCode: number | null;
  /** Failure reason. Null on success. */
  error: string | null;
};

/** Column width of ProbeResult.error; truncate rather than fail the insert. */
const MAX_ERROR_LENGTH = 500;

const NANOSECONDS_PER_MILLISECOND = 1_000_000;

function elapsedMs(startedAt: bigint): number {
  return Math.round(Number(process.hrtime.bigint() - startedAt) / NANOSECONDS_PER_MILLISECOND);
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_ERROR_LENGTH);
}

/** Configuration a probe needs, narrowed from the Service row. */
export type ProbeSpec = Pick<
  Service,
  'probeType' | 'probeTarget' | 'probeTimeoutMs' | 'expectedStatusMin' | 'expectedStatusMax'
>;

async function probeHttp(spec: ProbeSpec, target: string): Promise<ProbeOutcome> {
  const startedAt = process.hrtime.bigint();

  try {
    const response = await fetch(target, {
      /**
       * HEAD would be cheaper, but many services answer it with 405 while
       * being perfectly healthy. GET is what a real client does.
       */
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(spec.probeTimeoutMs),
      headers: { 'user-agent': 'Pulsara-Probe/1.0' },
    });

    /**
     * The body must be drained or the socket is never released back to the
     * agent, and a long-running scheduler slowly exhausts the connection pool.
     */
    await response.arrayBuffer().catch(() => undefined);

    const latencyMs = elapsedMs(startedAt);
    const withinRange =
      response.status >= spec.expectedStatusMin && response.status <= spec.expectedStatusMax;

    return {
      ok: withinRange,
      latencyMs,
      statusCode: response.status,
      error: withinRange
        ? null
        : `Status ${response.status} outside expected ${spec.expectedStatusMin}-${spec.expectedStatusMax}`,
    };
  } catch (error) {
    /**
     * A timeout still took real time, but that time measures our patience, not
     * the service's latency. Reporting it would drag the latency average toward
     * the timeout value, so latency is null whenever the check did not
     * complete.
     */
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    return {
      ok: false,
      latencyMs: null,
      statusCode: null,
      error: timedOut ? `Timed out after ${spec.probeTimeoutMs}ms` : describe(error),
    };
  }
}

function probeTcp(spec: ProbeSpec, target: string): Promise<ProbeOutcome> {
  const separator = target.lastIndexOf(':');
  const host = separator === -1 ? target : target.slice(0, separator);
  const port = Number(separator === -1 ? NaN : target.slice(separator + 1));

  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    return Promise.resolve({
      ok: false,
      latencyMs: null,
      statusCode: null,
      error: `Malformed TCP target "${target}"; expected host:port`,
    });
  }

  return new Promise<ProbeOutcome>((resolve) => {
    const startedAt = process.hrtime.bigint();
    const socket = connect({ host, port });
    let settled = false;

    const finish = (outcome: ProbeOutcome) => {
      if (settled) return;
      settled = true;
      // destroy(), not end(): a half-open connection to an unresponsive peer
      // would otherwise keep the handle alive past the timeout.
      socket.destroy();
      resolve(outcome);
    };

    socket.setTimeout(spec.probeTimeoutMs);

    socket.once('connect', () =>
      finish({ ok: true, latencyMs: elapsedMs(startedAt), statusCode: null, error: null }),
    );

    socket.once('timeout', () =>
      finish({
        ok: false,
        latencyMs: null,
        statusCode: null,
        error: `Timed out after ${spec.probeTimeoutMs}ms`,
      }),
    );

    socket.once('error', (error) =>
      finish({ ok: false, latencyMs: null, statusCode: null, error: describe(error) }),
    );
  });
}

export async function runProbe(spec: ProbeSpec): Promise<ProbeOutcome> {
  const target = spec.probeTarget?.trim();

  if (!spec.probeType || !target) {
    return {
      ok: false,
      latencyMs: null,
      statusCode: null,
      error: 'Service has no probe configured',
    };
  }

  switch (spec.probeType) {
    case ProbeType.HTTP:
      return probeHttp(spec, target);
    case ProbeType.TCP:
      return probeTcp(spec, target);
  }
}
