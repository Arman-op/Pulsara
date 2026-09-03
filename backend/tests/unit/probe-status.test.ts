import { ServiceState } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { nextStatus } from '../../src/modules/telemetry/probe-scheduler';
import type { ProbeOutcome } from '../../src/modules/telemetry/probe-runner';

/**
 * The hysteresis state machine.
 *
 * This is the function that decides whether an engineer gets paged, so it is
 * tested exhaustively rather than sampled. The thresholds come from the
 * environment and are pinned in tests/test-env.ts: three consecutive failures
 * to go OFFLINE, two consecutive successes to come back, degraded above 1000ms.
 */

const FAILURE_THRESHOLD = 3;
const RECOVERY_THRESHOLD = 2;
const DEGRADED_LATENCY_MS = 1_000;

const ok = (latencyMs: number | null = 50): ProbeOutcome => ({
  ok: true,
  latencyMs,
  statusCode: 200,
  error: null,
});

const failed = (): ProbeOutcome => ({
  ok: false,
  latencyMs: null,
  statusCode: null,
  error: 'connection refused',
});

describe('nextStatus', () => {
  it('does not declare an outage on a single failure', () => {
    expect(nextStatus(ServiceState.ONLINE, failed(), 1, 0)).toBe(ServiceState.DEGRADED);
    expect(nextStatus(ServiceState.ONLINE, failed(), FAILURE_THRESHOLD - 1, 0)).toBe(
      ServiceState.DEGRADED,
    );
  });

  it('declares an outage once the failure threshold is reached', () => {
    expect(nextStatus(ServiceState.DEGRADED, failed(), FAILURE_THRESHOLD, 0)).toBe(
      ServiceState.OFFLINE,
    );
  });

  it('keeps a service offline until the recovery threshold is met', () => {
    // One good probe is not evidence of recovery: an outage that flaps clears
    // and re-opens an incident every few seconds if this is wrong.
    expect(nextStatus(ServiceState.OFFLINE, ok(), 0, 1)).toBe(ServiceState.OFFLINE);
    expect(nextStatus(ServiceState.OFFLINE, ok(), 0, RECOVERY_THRESHOLD)).toBe(ServiceState.ONLINE);
  });

  it('treats a slow but reachable service as degraded, not healthy', () => {
    expect(
      nextStatus(ServiceState.ONLINE, ok(DEGRADED_LATENCY_MS + 1), 0, RECOVERY_THRESHOLD),
    ).toBe(ServiceState.DEGRADED);
    expect(nextStatus(ServiceState.ONLINE, ok(DEGRADED_LATENCY_MS), 0, RECOVERY_THRESHOLD)).toBe(
      ServiceState.ONLINE,
    );
  });

  it('never enters or leaves maintenance automatically', () => {
    // Maintenance is an operator's statement that alerts are expected. The
    // scheduler overriding it would page somebody during a planned deployment.
    expect(nextStatus(ServiceState.MAINTENANCE, failed(), FAILURE_THRESHOLD * 10, 0)).toBe(
      ServiceState.MAINTENANCE,
    );
    expect(nextStatus(ServiceState.MAINTENANCE, ok(), 0, RECOVERY_THRESHOLD * 10)).toBe(
      ServiceState.MAINTENANCE,
    );
  });

  it('does not promote a degraded service on a single success', () => {
    expect(nextStatus(ServiceState.DEGRADED, ok(), 0, 1)).toBe(ServiceState.DEGRADED);
  });

  it('handles a probe that reports no latency', () => {
    // A TCP probe can succeed without a meaningful duration; absent latency
    // must not be read as "faster than the degraded threshold" by accident.
    expect(nextStatus(ServiceState.DEGRADED, ok(null), 0, RECOVERY_THRESHOLD)).toBe(
      ServiceState.ONLINE,
    );
  });
});
