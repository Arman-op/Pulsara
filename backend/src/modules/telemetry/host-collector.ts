import { cpus, loadavg, platform } from 'node:os';
import si from 'systeminformation';
import { env } from '../../config/env';
import { prisma } from '../../db/prisma';
import { logger } from '../../lib/logger';
import { recordHostSnapshot } from './host-state';

/**
 * Host telemetry collector.
 *
 * Reads genuine operating-system counters through `systeminformation` and both
 * persists them and publishes them to connected clients.
 *
 * This replaces the generator that used to live in server.ts:
 *
 *     setInterval(() => io.emit('metrics', {
 *       cpu: Math.floor(15 + Math.random() * 45),
 *       memory: Math.floor(40 + Math.random() * 15),
 *       network: Math.floor(100 + Math.random() * 900),
 *       disk: 54,
 *     }), 2000);
 *
 * Every value there was invented — `disk` was a literal constant — nothing was
 * ever written to the Metric table, and the numbers were bounded to look
 * plausible, so the chart could never show a machine actually in trouble.
 */

/** Metric family names. Used as the `type` column and as chart series keys. */
export const MetricType = {
  CpuPercent: 'cpu',
  MemoryPercent: 'memory',
  DiskPercent: 'disk',
  NetworkRxBytesPerSecond: 'network_rx',
  NetworkTxBytesPerSecond: 'network_tx',
  LoadAverage1m: 'load_1m',
} as const;

export type MetricTypeName = (typeof MetricType)[keyof typeof MetricType];

const Unit = {
  Percent: 'percent',
  BytesPerSecond: 'bytes/s',
  Ratio: 'ratio',
} as const;

type Sample = { type: MetricTypeName; value: number; unit: string };

/** A snapshot as delivered to clients, one field per family. */
export type HostSnapshot = {
  host: string;
  cpu: number | null;
  memory: number | null;
  disk: number | null;
  networkRx: number | null;
  networkTx: number | null;
  load1m: number | null;
  timestamp: string;
};

const PERCENT_DECIMALS = 2;

/** Node returns a constant 0 from `loadavg()` on Windows; it is not a reading. */
const LOAD_AVERAGE_SUPPORTED = platform() !== 'win32';

const cpuCount = (): number => cpus().length;

function round(value: number, decimals = PERCENT_DECIMALS): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Clamps a percentage into range.
 *
 * Counter-derived percentages can land marginally outside 0-100 because the
 * numerator and denominator are sampled a few microseconds apart. Storing 100.4
 * would break a chart axis for no useful reason.
 */
function clampPercent(value: number): number {
  return round(Math.min(100, Math.max(0, value)));
}

/**
 * Reads every counter for one tick.
 *
 * Two of these readings are rate calculations that need a previous sample:
 * `currentLoad` reports load since boot on its first call, and `networkStats`
 * returns null rates until it has two observations to difference. `prime()`
 * takes and discards one reading at startup so the first sample a user sees is
 * a real interval measurement rather than a lifetime average.
 */
/**
 * How often the filesystem table is actually enumerated.
 *
 * Everything else here is a cheap counter read, but `fsSize()` shells out to
 * the platform — on Windows it invokes PowerShell, and a single call was
 * measured at between one and eight seconds on the development machine. At a
 * two-second sample cadence that means every tick collides with the previous
 * one and the collector spends its life skipping.
 *
 * Disk usage is also the one figure here that does not move quickly: a volume
 * does not fill and drain between heartbeats the way CPU does. Reading it once
 * a minute and reusing the value keeps the fast metrics fast, and costs nothing
 * that anybody could act on.
 */
const DISK_SAMPLE_INTERVAL_MS = 60_000;

let cachedDisk: { value: number | null; readAt: number } | null = null;

/**
 * Fullest mounted volume, cached.
 *
 * Whichever mount is fullest, not an average across them: one full volume is an
 * outage even when the others are empty.
 */
async function readDiskPercent(): Promise<number | null> {
  const now = Date.now();
  if (cachedDisk && now - cachedDisk.readAt < DISK_SAMPLE_INTERVAL_MS) {
    return cachedDisk.value;
  }

  const disks = await si.fsSize();
  const mountedUsages = disks
    .filter((disk) => Number.isFinite(disk.use) && disk.size > 0)
    .map((disk) => disk.use);

  const value = mountedUsages.length > 0 ? clampPercent(Math.max(...mountedUsages)) : null;
  cachedDisk = { value, readAt: now };
  return value;
}

/** Test seam; a running process has one collector and one cache. */
export function resetDiskCache(): void {
  cachedDisk = null;
}

async function readHost(): Promise<Sample[]> {
  const [load, memory, networks, diskPercent] = await Promise.all([
    si.currentLoad(),
    si.mem(),
    si.networkStats(),
    readDiskPercent(),
  ]);

  const samples: Sample[] = [
    { type: MetricType.CpuPercent, value: clampPercent(load.currentLoad), unit: Unit.Percent },
  ];

  /**
   * `active` rather than `used`. On Linux, `used` counts the page cache, which
   * the kernel will hand back on demand, so it sits near 100% on any healthy
   * machine and would make the memory series useless.
   */
  if (memory.total > 0) {
    samples.push({
      type: MetricType.MemoryPercent,
      value: clampPercent((memory.active / memory.total) * 100),
      unit: Unit.Percent,
    });
  }

  if (diskPercent !== null) {
    samples.push({ type: MetricType.DiskPercent, value: diskPercent, unit: Unit.Percent });
  }

  // Sum across interfaces; a host may be multi-homed.
  const rx = networks.reduce((total, iface) => total + (iface.rx_sec ?? 0), 0);
  const tx = networks.reduce((total, iface) => total + (iface.tx_sec ?? 0), 0);
  const hasRates = networks.some((iface) => iface.rx_sec !== null && iface.rx_sec !== undefined);

  if (hasRates) {
    samples.push(
      {
        type: MetricType.NetworkRxBytesPerSecond,
        value: round(Math.max(0, rx)),
        unit: Unit.BytesPerSecond,
      },
      {
        type: MetricType.NetworkTxBytesPerSecond,
        value: round(Math.max(0, tx)),
        unit: Unit.BytesPerSecond,
      },
    );
  }

  /**
   * Load average is normalised by core count so the figure means the same thing
   * on a 4-core and a 64-core host: 1.0 is "fully committed".
   *
   * Windows has no load average and Node reports a constant 0 there, so the
   * family is omitted on that platform rather than recorded as a genuine zero —
   * a flat line at 0 would read as "idle" instead of "not measured".
   */
  const cores = cpuCount();
  const oneMinute = loadavg()[0];

  if (LOAD_AVERAGE_SUPPORTED && typeof oneMinute === 'number' && cores > 0) {
    samples.push({
      type: MetricType.LoadAverage1m,
      value: round(oneMinute / cores, 3),
      unit: Unit.Ratio,
    });
  }

  return samples;
}

function toSnapshot(samples: Sample[], host: string, timestamp: Date): HostSnapshot {
  const find = (type: MetricTypeName) => samples.find((s) => s.type === type)?.value ?? null;
  return {
    host,
    cpu: find(MetricType.CpuPercent),
    memory: find(MetricType.MemoryPercent),
    disk: find(MetricType.DiskPercent),
    networkRx: find(MetricType.NetworkRxBytesPerSecond),
    networkTx: find(MetricType.NetworkTxBytesPerSecond),
    load1m: find(MetricType.LoadAverage1m),
    timestamp: timestamp.toISOString(),
  };
}

/**
 * Accumulator for one persistence window.
 *
 * Sampling and writing are deliberately on different clocks. Every sample is
 * published live and evaluated for alerts; only the mean of each window reaches
 * the database. At a two-second cadence, writing every sample produced roughly
 * a quarter of a million rows a day per host to draw a chart that re-buckets
 * them on read anyway.
 *
 * The mean is the right summary here because the chart already averages within
 * its own buckets, and because equal-length windows make a mean of means equal
 * to the mean. Peaks are not lost to alerting, which never reads this table.
 */
type Window = { sum: number; count: number; unit: string };

function accumulate(windows: Map<MetricTypeName, Window>, samples: Sample[]): void {
  for (const sample of samples) {
    const existing = windows.get(sample.type);
    if (existing) {
      existing.sum += sample.value;
      existing.count += 1;
    } else {
      windows.set(sample.type, { sum: sample.value, count: 1, unit: sample.unit });
    }
  }
}

export type HostCollector = {
  /** The most recent snapshot, so a newly connected client gets data at once. */
  latest: () => HostSnapshot | null;
  stop: () => void;
};

/**
 * Intervals are injectable so a test can drive the two clocks fast enough to
 * observe that they are genuinely independent. Production passes neither and
 * gets the configured values.
 */
export type HostCollectorOptions = {
  sampleIntervalMs?: number;
  persistIntervalMs?: number;
};

export function startHostCollector(
  publish: (snapshot: HostSnapshot) => void,
  options: HostCollectorOptions = {},
): HostCollector {
  const sampleIntervalMs = options.sampleIntervalMs ?? env.METRICS_SAMPLE_INTERVAL_MS;
  const persistIntervalMs = options.persistIntervalMs ?? env.METRICS_PERSIST_INTERVAL_MS;

  let latest: HostSnapshot | null = null;
  let sampleTimer: NodeJS.Timeout | null = null;
  let persistTimer: NodeJS.Timeout | null = null;
  let stopped = false;

  const windows = new Map<MetricTypeName, Window>();

  async function sample(): Promise<void> {
    try {
      const samples = await readHost();
      const observedAt = new Date();

      accumulate(windows, samples);

      latest = toSnapshot(samples, env.TELEMETRY_HOST_ID, observedAt);
      recordHostSnapshot(latest);
      publish(latest);
    } catch (error) {
      /**
       * Telemetry collection must never take the process down. A failed read is
       * logged and the next tick tries again; clients simply see a gap in the
       * series, which is the truthful representation of a period we did not
       * measure.
       */
      logger.error({ err: error }, 'Host metric sampling failed');
    }
  }

  async function persist(): Promise<void> {
    if (windows.size === 0) return;

    /**
     * The buffer is drained before the await, not after. Leaving it in place
     * while the insert is in flight would let samples taken during the write be
     * counted again in the next window.
     */
    const draining = [...windows.entries()];
    windows.clear();

    const recordedAt = new Date();

    try {
      await prisma.metric.createMany({
        data: draining.map(([type, window]) => ({
          type,
          value: round(window.sum / window.count),
          unit: window.unit,
          host: env.TELEMETRY_HOST_ID,
          recordedAt,
        })),
      });
    } catch (error) {
      // A database blip costs one window, not the collector. Re-queueing the
      // drained samples would mean the next write silently spans two windows
      // and is no longer the mean of anything.
      logger.error({ err: error }, 'Host metric persistence failed; this window is lost');
    }
  }

  /**
   * The sample loop is self-pacing: the next read is scheduled once the
   * previous one has finished, rather than on a fixed-rate interval.
   *
   * The cost of reading a counter is not a constant. On Linux these are procfs
   * reads and return in microseconds; on Windows `networkStats()` shells out
   * and was measured at around four seconds on the development machine. A fixed
   * interval on that platform queues a new read before the last has returned,
   * forever — and the usual patch for it, skipping a tick while one is in
   * flight, turns a real cadence into a stream of warnings that say nothing an
   * operator can act on.
   *
   * Self-pacing degrades honestly instead: the configured interval is the gap
   * between samples, so a slow platform simply samples less often, and the
   * `pulsara_host_sample_age_seconds` gauge says by how much.
   */
  function scheduleNextSample(): void {
    sampleTimer = setTimeout(() => {
      void sample().finally(() => {
        if (!stopped) scheduleNextSample();
      });
    }, sampleIntervalMs);
  }

  async function start(): Promise<void> {
    /**
     * Prime the rate counters, then discard the result. `currentLoad` reports
     * load since boot on its first call and `networkStats` returns null rates
     * until it has two observations to difference, so without this the first
     * sample a user sees is a lifetime average rather than an interval
     * measurement.
     */
    try {
      await readHost();
    } catch (error) {
      logger.warn({ err: error }, 'Host metric priming read failed; rates may lag one tick');
    }

    if (stopped) return;

    await sample();

    if (stopped) return;

    scheduleNextSample();
    persistTimer = setInterval(() => void persist(), persistIntervalMs);
  }

  void start();

  logger.info(
    { host: env.TELEMETRY_HOST_ID, sampleIntervalMs, persistIntervalMs },
    'Host metric collector started',
  );

  return {
    latest: () => latest,
    stop: () => {
      stopped = true;
      if (sampleTimer) clearTimeout(sampleTimer);
      if (persistTimer) clearInterval(persistTimer);
      sampleTimer = null;
      persistTimer = null;
      // One last write, so a rollout does not silently discard the window in
      // progress on every replica it replaces.
      void persist();
    },
  };
}
