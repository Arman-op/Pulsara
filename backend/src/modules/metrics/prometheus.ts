import { ServiceState, Severity } from '@prisma/client';
import { Gauge, Registry, collectDefaultMetrics } from 'prom-client';
import { MS_PER_SECOND } from '../../config/constants';
import { env } from '../../config/env';
import { prisma } from '../../db/prisma';
import { latestHostSnapshot } from '../telemetry/host-state';
import { getServiceHealth } from '../telemetry/telemetry.service';

/**
 * Prometheus exposition.
 *
 * The dashboard is one consumer of this data; it should not be the only one. A
 * system that can only be observed through its own UI cannot be alerted on by
 * the tooling an organisation already runs, cannot be graphed beside anything
 * else, and stops being observable at exactly the moment its own front end is
 * the thing that has broken.
 *
 * Conventions followed here, because getting them wrong is what makes an
 * exporter unpleasant to consume:
 *
 *  - **Base units.** Seconds and bytes, never milliseconds or megabytes, and
 *    ratios in 0..1 rather than percentages. That is Prometheus' own guidance
 *    and the reason expressions compose across exporters at all. The internal
 *    model keeps percentages because that is what a chart axis wants; the
 *    conversion happens here, once.
 *  - **The suffix states the unit**: `_seconds`, `_bytes`, `_ratio`.
 *  - **Bounded label cardinality.** Service names come from an operator-managed
 *    catalogue, so they are safe. Nothing is labelled by incident id, request
 *    path, or anything else that grows without limit — that is how an exporter
 *    takes a Prometheus server down.
 *  - **Absent means unmeasured.** A metric with no reading is omitted rather
 *    than reported as zero, which would draw a healthy-looking flat line.
 */

const PREFIX = 'pulsara_';

/** Percentages are stored 0-100 internally and exposed 0-1 here. */
const PERCENT_TO_RATIO = 100;

export const registry = new Registry();

/**
 * Standard `process_*` and `nodejs_*` series: resident memory, CPU seconds,
 * event-loop lag, heap, open handles. Every Node dashboard and alert rule
 * expects these under exactly these names, so they come from the library rather
 * than being reinvented under a house prefix.
 */
collectDefaultMetrics({ register: registry });

/** Sets a gauge to a real reading, or leaves the series absent when there is none. */
function setOrOmit(
  gauge: Gauge<string>,
  labels: Record<string, string>,
  value: number | null,
): void {
  if (value === null || !Number.isFinite(value)) return;
  gauge.set(labels, value);
}

// --- Host -------------------------------------------------------------------

const hostCpu = new Gauge({
  name: `${PREFIX}host_cpu_usage_ratio`,
  help: 'Current CPU utilisation of the host, 0-1.',
  labelNames: ['host'],
  registers: [registry],
});

const hostMemory = new Gauge({
  name: `${PREFIX}host_memory_usage_ratio`,
  help: 'Active memory as a fraction of total, 0-1. Excludes reclaimable page cache.',
  labelNames: ['host'],
  registers: [registry],
});

const hostDisk = new Gauge({
  name: `${PREFIX}host_disk_usage_ratio`,
  help: 'Usage of the fullest mounted filesystem, 0-1.',
  labelNames: ['host'],
  registers: [registry],
});

const hostNetworkRx = new Gauge({
  name: `${PREFIX}host_network_receive_bytes_per_second`,
  help: 'Bytes received per second, summed across interfaces.',
  labelNames: ['host'],
  registers: [registry],
});

const hostNetworkTx = new Gauge({
  name: `${PREFIX}host_network_transmit_bytes_per_second`,
  help: 'Bytes transmitted per second, summed across interfaces.',
  labelNames: ['host'],
  registers: [registry],
});

const hostLoad = new Gauge({
  name: `${PREFIX}host_load1_per_core_ratio`,
  help: 'One-minute load average divided by core count; 1 is fully committed. Absent on Windows.',
  labelNames: ['host'],
  registers: [registry],
});

const hostSampleAge = new Gauge({
  name: `${PREFIX}host_sample_age_seconds`,
  help: 'Age of the newest host sample. Rises without bound if the collector has stopped.',
  labelNames: ['host'],
  registers: [registry],
});

const HOST_GAUGES = [
  hostCpu,
  hostMemory,
  hostDisk,
  hostNetworkRx,
  hostNetworkTx,
  hostLoad,
  hostSampleAge,
];

/**
 * Fills the host gauges from a single snapshot.
 *
 * Done in one function called once per scrape, rather than as a `collect()`
 * hook on each gauge, so that a scrape cannot report a CPU figure from one
 * sample beside a memory figure from the next: prom-client resolves each
 * metric's hook independently, and the collector replaces the snapshot every
 * couple of seconds underneath it.
 */
function refreshHostGauges(): void {
  for (const gauge of HOST_GAUGES) gauge.reset();

  const snapshot = latestHostSnapshot();
  if (!snapshot) return;

  const labels = { host: snapshot.host };
  const ratio = (percent: number | null) => (percent === null ? null : percent / PERCENT_TO_RATIO);

  setOrOmit(hostCpu, labels, ratio(snapshot.cpu));
  setOrOmit(hostMemory, labels, ratio(snapshot.memory));
  setOrOmit(hostDisk, labels, ratio(snapshot.disk));
  setOrOmit(hostNetworkRx, labels, snapshot.networkRx);
  setOrOmit(hostNetworkTx, labels, snapshot.networkTx);
  setOrOmit(hostLoad, labels, snapshot.load1m);

  /**
   * Staleness is itself a metric. Without it a stopped collector looks exactly
   * like a perfectly steady machine, and the alert that should fire is the one
   * that never does.
   */
  hostSampleAge.set(labels, (Date.now() - new Date(snapshot.timestamp).getTime()) / MS_PER_SECOND);
}

// --- Services ---------------------------------------------------------------

const serviceUp = new Gauge({
  name: `${PREFIX}service_up`,
  help: 'Whether a monitored service is currently reachable: 1 online, 0 otherwise.',
  labelNames: ['service', 'state'],
  registers: [registry],
});

const serviceUptime = new Gauge({
  name: `${PREFIX}service_uptime_ratio`,
  help: 'Successful probes as a fraction of all probes in the configured window, 0-1.',
  labelNames: ['service'],
  registers: [registry],
});

const serviceLatency = new Gauge({
  name: `${PREFIX}service_latency_seconds`,
  help: 'Probe latency over the configured window, by quantile.',
  labelNames: ['service', 'quantile'],
  registers: [registry],
});

const serviceProbes = new Gauge({
  name: `${PREFIX}service_probe_samples`,
  help: 'Probes recorded in the window. Zero means the figures above are absent, not zero.',
  labelNames: ['service'],
  registers: [registry],
});

const SERVICE_GAUGES = [serviceUp, serviceUptime, serviceLatency, serviceProbes];

/** Same reasoning as the host group: one query, one consistent set of series. */
async function refreshServiceGauges(): Promise<void> {
  for (const gauge of SERVICE_GAUGES) gauge.reset();

  const [services, health] = await Promise.all([
    prisma.service.findMany({
      where: { isMonitored: true },
      select: { id: true, name: true, status: true },
    }),
    getServiceHealth(),
  ]);

  for (const service of services) {
    /**
     * `state` rides along as a label so MAINTENANCE stays distinguishable from
     * a genuine outage. Both are `service_up 0`, and paging on the second while
     * ignoring the first is the entire reason a maintenance state exists.
     */
    serviceUp.set(
      { service: service.name, state: service.status },
      service.status === ServiceState.ONLINE ? 1 : 0,
    );

    const measured = health.get(service.id);
    if (!measured) continue;

    serviceProbes.set({ service: service.name }, measured.sampleCount);

    setOrOmit(
      serviceUptime,
      { service: service.name },
      measured.uptimePercent === null ? null : measured.uptimePercent / PERCENT_TO_RATIO,
    );
    setOrOmit(
      serviceLatency,
      { service: service.name, quantile: '0.5' },
      measured.latencyP50Ms === null ? null : measured.latencyP50Ms / MS_PER_SECOND,
    );
    setOrOmit(
      serviceLatency,
      { service: service.name, quantile: '0.95' },
      measured.latencyP95Ms === null ? null : measured.latencyP95Ms / MS_PER_SECOND,
    );
  }
}

// --- Single-gauge groups ----------------------------------------------------
// These own all of their own series, so a per-metric `collect()` hook is safe
// and keeps the value computation next to its declaration.

export const alertThreshold = new Gauge({
  name: `${PREFIX}host_alert_threshold_ratio`,
  help: 'Threshold above which this resource opens an incident, 0-1.',
  labelNames: ['resource'],
  registers: [registry],
  collect() {
    /**
     * Exporting the thresholds lets a dashboard draw the line the incident
     * engine is actually using, rather than one somebody copied into a panel
     * and then forgot to change when the configuration moved.
     */
    this.set({ resource: 'cpu' }, env.CPU_ALERT_THRESHOLD_PERCENT / PERCENT_TO_RATIO);
    this.set({ resource: 'memory' }, env.MEMORY_ALERT_THRESHOLD_PERCENT / PERCENT_TO_RATIO);
    this.set({ resource: 'disk' }, env.DISK_ALERT_THRESHOLD_PERCENT / PERCENT_TO_RATIO);
  },
});

export const openIncidents = new Gauge({
  name: `${PREFIX}incidents_open`,
  help: 'Currently open incidents, by severity and by how they were raised.',
  labelNames: ['severity', 'source'],
  registers: [registry],
  async collect() {
    this.reset();

    const rows = await prisma.incident.groupBy({
      by: ['severity', 'source'],
      where: { isOpen: true },
      _count: { _all: true },
    });

    /**
     * Every combination is emitted, at zero if need be. A series that only
     * appears once something is wrong makes `pulsara_incidents_open == 0`
     * useless as an alert condition, because an alert on an absent series never
     * fires — the classic way a "we are alerted on this" claim turns out to be
     * false during the incident it was meant to catch.
     */
    for (const severity of Object.values(Severity)) {
      for (const source of ['AUTOMATED', 'MANUAL']) {
        const match = rows.find((row) => row.severity === severity && row.source === source);
        this.set({ severity, source }, match?._count._all ?? 0);
      }
    }
  },
});

export const deployments = new Gauge({
  name: `${PREFIX}deployments`,
  help: 'Mirrored CI runs currently recorded, by status.',
  labelNames: ['status'],
  registers: [registry],
  async collect() {
    this.reset();

    const rows = await prisma.deployment.groupBy({ by: ['status'], _count: { _all: true } });
    for (const row of rows) this.set({ status: row.status }, row._count._all);
  },
});

export const buildInfo = new Gauge({
  name: `${PREFIX}build_info`,
  help: 'Always 1; the labels carry the information. The conventional shape for build metadata.',
  labelNames: ['version', 'node', 'environment', 'host'],
  registers: [registry],
  collect() {
    this.reset();
    this.set(
      {
        version: process.env.npm_package_version ?? 'unknown',
        node: process.version,
        environment: env.NODE_ENV,
        host: env.TELEMETRY_HOST_ID,
      },
      1,
    );
  },
});

/** The content type Prometheus expects, including the format version. */
export const expositionContentType = (): string => registry.contentType;

export async function renderMetrics(): Promise<string> {
  refreshHostGauges();
  await refreshServiceGauges();
  return registry.metrics();
}
