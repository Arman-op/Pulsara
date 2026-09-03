import { ServiceState, Severity } from '@prisma/client';
import { MS_PER_SECOND } from '../../config/constants';
import { logger } from '../../lib/logger';
import type { ServiceStatusChange } from '../telemetry/probe-scheduler';
import { openOrEscalateIncident, resolveAutomatedIncident } from './incident-store';

/**
 * Alerting from service reachability.
 *
 * Turns observed service state transitions into incidents, and closes them
 * again when the service recovers. Every incident it opens is backed by real
 * probe results; nothing here invents a condition.
 *
 * The previous seed wrote two fixed incidents ("High latency on Background
 * Workers", "Database connection drop") that were never created by anything
 * observing anything, never changed, and never resolved.
 *
 * The write rules — dedupe by condition, escalate but never de-escalate, only
 * close what a machine opened — live in `incident-store.ts`, shared with the
 * host-threshold engine.
 */

/** Severity implied by the state a service has entered. */
const SEVERITY_BY_STATE: Partial<Record<ServiceState, Severity>> = {
  [ServiceState.OFFLINE]: Severity.CRITICAL,
  [ServiceState.DEGRADED]: Severity.MEDIUM,
};

/**
 * Keyed by service alone rather than by service and state, so a service that
 * slides from DEGRADED to OFFLINE escalates the incident it already has instead
 * of opening a second one for the same outage.
 */
function dedupeKeyFor(serviceId: string): string {
  return `service-availability:${serviceId}`;
}

/** Human-readable summary of the state a service is in. */
function titleFor(serviceName: string, state: ServiceState): string {
  return state === ServiceState.OFFLINE
    ? serviceName + ' is unreachable'
    : serviceName + ' is degraded';
}

function describeTransition(change: ServiceStatusChange): string {
  const reason = change.error ? ` (${change.error})` : '';
  return `${change.name} moved from ${change.previous} to ${change.current}${reason}`;
}

/**
 * Reacts to one status transition.
 *
 * Called by the probe scheduler for every change it records. Failures are
 * logged rather than propagated: an alerting problem must never stop the
 * monitoring that feeds it.
 */
export async function handleServiceStatusChange(change: ServiceStatusChange): Promise<void> {
  try {
    if (change.current === ServiceState.ONLINE) {
      await resolveAutomatedIncident(
        dedupeKeyFor(change.serviceId),
        change.name,
        (openDurationMs) =>
          `${change.name} recovered to ${change.current} after ${Math.round(openDurationMs / MS_PER_SECOND)}s`,
      );
      return;
    }

    /**
     * Entering maintenance is a planned action, not an outage, so it opens
     * nothing. Any incident already open stays open: a service that was
     * genuinely broken before the window began is still broken.
     */
    if (change.current === ServiceState.MAINTENANCE) return;

    const severity = SEVERITY_BY_STATE[change.current];
    if (!severity) return;

    await openOrEscalateIncident({
      dedupeKey: dedupeKeyFor(change.serviceId),
      title: titleFor(change.name, change.current),
      description: describeTransition(change),
      severity,
      serviceId: change.serviceId,
      subject: change.name,
    });
  } catch (error) {
    logger.error({ err: error, service: change.name }, 'Alerting engine failed to process change');
  }
}
