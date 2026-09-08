import { DeploymentStatus, ProbeType, ServiceState, Severity } from '@prisma/client';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../../src/app';
import { prisma } from '../../src/db/prisma';
import { recordHostSnapshot, resetHostSnapshot } from '../../src/modules/telemetry/host-state';
import { disconnectDatabase, resetDatabase } from '../helpers/database';

/**
 * The Prometheus scrape endpoint.
 *
 * What is worth asserting here is not that numbers appear, but that the
 * exposition obeys the conventions a scraper and its dashboards rely on: base
 * units, a HELP and TYPE line per family, absent rather than zero for an
 * unmeasured value, and a series present at zero where an alert rule needs to
 * be able to compare against it.
 */

beforeEach(async () => {
  await resetDatabase();
  resetHostSnapshot();
});

afterEach(resetHostSnapshot);
afterAll(disconnectDatabase);

const scrape = () => request(app).get('/metrics');

/** Reads the value of one sample line, or null when the series is absent. */
function sample(body: string, name: string, labels?: string): number | null {
  const line = body
    .split('\n')
    .find(
      (candidate) =>
        candidate.startsWith(`${name}{`) && (labels === undefined || candidate.includes(labels)),
    );
  if (!line) return null;
  const value = line.slice(line.lastIndexOf('}') + 1).trim();
  return Number(value);
}

describe('GET /metrics', () => {
  it('serves the Prometheus text exposition format', async () => {
    const response = await scrape().expect(200);

    // The version is part of the contract: a scraper negotiates on it.
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.headers['content-type']).toContain('version=0.0.4');
    // A cached scrape would make a stalled exporter look alive.
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('documents every family with HELP and TYPE', async () => {
    const body = (await scrape().expect(200)).text;

    for (const family of [
      'pulsara_host_cpu_usage_ratio',
      'pulsara_service_up',
      'pulsara_incidents_open',
      'pulsara_build_info',
    ]) {
      expect(body).toContain(`# HELP ${family} `);
      expect(body).toContain(`# TYPE ${family} gauge`);
    }
  });

  it('includes the standard Node process metrics under their conventional names', async () => {
    // Every Node dashboard expects these names; renaming them under a house
    // prefix would break every off-the-shelf panel and alert rule.
    const body = (await scrape().expect(200)).text;

    expect(body).toContain('process_resident_memory_bytes');
    expect(body).toContain('nodejs_eventloop_lag_seconds');
  });

  it('is not wrapped in the JSON envelope the rest of the API uses', async () => {
    // A scraper handed {"success":true,...} simply fails to parse it.
    const body = (await scrape().expect(200)).text;
    expect(body.startsWith('{')).toBe(false);
  });
});

describe('host gauges', () => {
  it('reports percentages as ratios in base units', async () => {
    recordHostSnapshot({
      host: 'test-host',
      cpu: 42.5,
      memory: 61,
      disk: 78.25,
      networkRx: 2048,
      networkTx: 512,
      load1m: 0.75,
      timestamp: new Date().toISOString(),
    });

    const body = (await scrape().expect(200)).text;

    // 42.5% becomes 0.425: Prometheus convention is a ratio, not a percentage.
    expect(sample(body, 'pulsara_host_cpu_usage_ratio')).toBeCloseTo(0.425, 5);
    expect(sample(body, 'pulsara_host_memory_usage_ratio')).toBeCloseTo(0.61, 5);
    expect(sample(body, 'pulsara_host_disk_usage_ratio')).toBeCloseTo(0.7825, 5);
    // Rates are already in base units and pass through unchanged.
    expect(sample(body, 'pulsara_host_network_receive_bytes_per_second')).toBe(2048);
  });

  it('omits a family that was not measured rather than reporting zero', async () => {
    /**
     * Absent is how Prometheus says "no reading". A zero would draw a
     * healthy-looking flat line for a metric nobody collected — the exact lie
     * this project exists to stop telling.
     */
    recordHostSnapshot({
      host: 'test-host',
      cpu: 42.5,
      memory: null,
      disk: null,
      networkRx: null,
      networkTx: null,
      load1m: null,
      timestamp: new Date().toISOString(),
    });

    const body = (await scrape().expect(200)).text;

    expect(sample(body, 'pulsara_host_cpu_usage_ratio')).toBeCloseTo(0.425, 5);
    expect(sample(body, 'pulsara_host_memory_usage_ratio')).toBeNull();
    expect(sample(body, 'pulsara_host_load1_per_core_ratio')).toBeNull();
  });

  it('exposes sample age, so a stopped collector is visible', async () => {
    const twoMinutesAgo = new Date(Date.now() - 120_000).toISOString();
    recordHostSnapshot({
      host: 'test-host',
      cpu: 10,
      memory: 10,
      disk: 10,
      networkRx: 0,
      networkTx: 0,
      load1m: 0,
      timestamp: twoMinutesAgo,
    });

    const age = sample((await scrape().expect(200)).text, 'pulsara_host_sample_age_seconds');
    expect(age).toBeGreaterThanOrEqual(120);
  });

  it('publishes the thresholds the alerting engine is actually using', async () => {
    const body = (await scrape().expect(200)).text;

    expect(sample(body, 'pulsara_host_alert_threshold_ratio', 'resource="cpu"')).toBeCloseTo(
      0.9,
      5,
    );
    expect(sample(body, 'pulsara_host_alert_threshold_ratio', 'resource="disk"')).toBeCloseTo(
      0.85,
      5,
    );
  });
});

describe('service gauges', () => {
  it('reports reachability, uptime as a ratio and latency in seconds', async () => {
    const service = await prisma.service.create({
      data: { name: 'Pulsara API', status: ServiceState.ONLINE, probeIntervalSeconds: 30 },
    });

    const checkedAt = new Date();
    await prisma.probeResult.createMany({
      data: [
        { serviceId: service.id, ok: true, latencyMs: 100, checkedAt },
        { serviceId: service.id, ok: true, latencyMs: 200, checkedAt },
        { serviceId: service.id, ok: false, latencyMs: null, checkedAt },
      ],
    });

    const body = (await scrape().expect(200)).text;

    expect(sample(body, 'pulsara_service_up', 'service="Pulsara API"')).toBe(1);
    // Two of three probes succeeded.
    expect(sample(body, 'pulsara_service_uptime_ratio', 'service="Pulsara API"')).toBeCloseTo(
      2 / 3,
      3,
    );
    // 150ms median, reported in seconds.
    expect(sample(body, 'pulsara_service_latency_seconds', 'quantile="0.5"')).toBeCloseTo(0.15, 3);
    expect(sample(body, 'pulsara_service_probe_samples')).toBe(3);
  });

  it('labels the state, so maintenance is distinguishable from an outage', async () => {
    // Both are `service_up 0`; alerting on one and not the other is the entire
    // reason a maintenance state exists.
    await prisma.service.create({
      data: { name: 'Planned', status: ServiceState.MAINTENANCE, probeIntervalSeconds: 30 },
    });

    const body = (await scrape().expect(200)).text;

    expect(sample(body, 'pulsara_service_up', 'state="MAINTENANCE"')).toBe(0);
  });

  it('leaves uptime absent for a service that has never been probed', async () => {
    await prisma.service.create({
      data: { name: 'Unprobed', status: ServiceState.DEGRADED, probeIntervalSeconds: 30 },
    });

    const body = (await scrape().expect(200)).text;

    expect(sample(body, 'pulsara_service_up', 'service="Unprobed"')).toBe(0);
    expect(sample(body, 'pulsara_service_uptime_ratio', 'service="Unprobed"')).toBeNull();
  });

  it('reports how long ago each service was probed, beside its own interval', async () => {
    /**
     * The pair exists for a failure nothing else here can express: if the probe
     * worker stalls, every other service series keeps reporting the last window
     * it measured and the alerting engines stay quiet, because they open
     * incidents from observations and an absent observation is not a failed
     * one. The age is what makes a stopped prober visible, and the interval is
     * what an alert compares it against — one global threshold would be wrong
     * for everything except the median service.
     */
    await prisma.service.create({
      data: {
        name: 'Checked',
        status: ServiceState.ONLINE,
        probeType: ProbeType.HTTP,
        probeTarget: 'https://example.test/health',
        probeIntervalSeconds: 45,
        lastCheckedAt: new Date(Date.now() - 90_000),
      },
    });

    const body = (await scrape().expect(200)).text;

    expect(sample(body, 'pulsara_service_probe_interval_seconds', 'service="Checked"')).toBe(45);
    // Ninety seconds ago, in seconds, allowing for the time the scrape took.
    expect(sample(body, 'pulsara_service_last_check_age_seconds', 'service="Checked"')).toBeCloseTo(
      90,
      0,
    );
  });

  it('leaves the age absent for a service that is catalogued but not probed', async () => {
    /**
     * Two different absences, and both must stay absent rather than become
     * zero. A service with no `probeType` is registered for reference and has
     * no schedule to be late for; a probed service that has never run yet has
     * no age to report. Zero would read as "checked just now", which is the
     * opposite of the truth in both cases.
     */
    await prisma.service.create({
      data: { name: 'Catalogued', status: ServiceState.ONLINE, probeIntervalSeconds: 30 },
    });
    await prisma.service.create({
      data: {
        name: 'Never run',
        status: ServiceState.ONLINE,
        probeType: ProbeType.TCP,
        probeTarget: 'db.example.test:5432',
        probeIntervalSeconds: 30,
      },
    });

    const body = (await scrape().expect(200)).text;

    expect(
      sample(body, 'pulsara_service_probe_interval_seconds', 'service="Catalogued"'),
    ).toBeNull();
    expect(
      sample(body, 'pulsara_service_last_check_age_seconds', 'service="Catalogued"'),
    ).toBeNull();

    // Scheduled, so its interval is published; never run, so it has no age.
    expect(sample(body, 'pulsara_service_probe_interval_seconds', 'service="Never run"')).toBe(30);
    expect(
      sample(body, 'pulsara_service_last_check_age_seconds', 'service="Never run"'),
    ).toBeNull();
  });
});

describe('incident and deployment gauges', () => {
  it('emits every severity even at zero, so an alert rule can compare against it', async () => {
    /**
     * An alert on an absent series never fires. Emitting only non-zero
     * severities is the classic way a "we are alerted on this" claim turns out
     * to be false during the incident it was meant to catch.
     */
    const body = (await scrape().expect(200)).text;

    for (const severity of Object.values(Severity)) {
      expect(sample(body, 'pulsara_incidents_open', `severity="${severity}"`)).toBe(0);
    }
  });

  it('counts open incidents by severity and source', async () => {
    await prisma.incident.createMany({
      data: [
        { title: 'a', severity: Severity.CRITICAL, isOpen: true },
        { title: 'b', severity: Severity.CRITICAL, isOpen: true },
        { title: 'c', severity: Severity.LOW, isOpen: false },
      ],
    });

    const body = (await scrape().expect(200)).text;

    expect(sample(body, 'pulsara_incidents_open', 'severity="CRITICAL",source="MANUAL"')).toBe(2);
    // Resolved incidents are not open ones.
    expect(sample(body, 'pulsara_incidents_open', 'severity="LOW",source="MANUAL"')).toBe(0);
  });

  it('counts mirrored CI runs by status', async () => {
    await prisma.deployment.create({
      data: {
        externalId: '1',
        externalUrl: 'https://example.test/1',
        repo: 'pulsara/pulsara',
        branch: 'main',
        event: 'push',
        commitSha: 'a'.repeat(40),
        status: DeploymentStatus.SUCCESS,
      },
    });

    const body = (await scrape().expect(200)).text;
    expect(sample(body, 'pulsara_deployments', 'status="SUCCESS"')).toBe(1);
  });
});
