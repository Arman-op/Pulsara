import { cpus, loadavg, platform } from 'node:os';
import si from 'systeminformation';
import { env } from '../../config/env';
import { prisma } from '../../db/prisma';
import { logger } from '../../lib/logger';

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
async function readHost(): Promise<Sample[]> {
  const [load, memory, disks, networks] = await Promise.all([
    si.currentLoad(),
    si.mem(),
    si.fsSize(),
    si.networkStats(),
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

  /**
   * Disk pressure is whichever mount is fullest, not an average across them:
   * one full volume is an outage even when the others are empty.
   */
  const mountedUsages = disks
    .filter((disk) => Number.isFinite(disk.use) && disk.size > 0)
    .map((disk) => disk.use);

  if (mountedUsages.length > 0) {
    samples.push({
      type: MetricType.DiskPercent,
      value: clampPercent(Math.max(...mountedUsages)),
      unit: Unit.Percent,
    });
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

export type HostCollector = {
  /** The most recent snapshot, so a newly connected client gets data at once. */
  latest: () => HostSnapshot | null;
  stop: () => void;
};

export function startHostCollector(publish: (snapshot: HostSnapshot) => void): HostCollector {
  let latest: HostSnapshot | null = null;
  let timer: NodeJS.Timeout | null = null;
  let collecting = false;

  async function tick(): Promise<void> {
    /**
     * A tick is skipped if the previous one is still running. Without this
     * guard a slow disk enumeration would let ticks pile up and each new one
     * would make the contention worse.
     */
    if (collecting) {
      logger.warn('Host metric collection still in progress; skipping this tick');
      return;
    }

    collecting = true;
    try {
      const samples = await readHost();
      const recordedAt = new Date();

      await prisma.metric.createMany({
        data: samples.map((sample) => ({
          type: sample.type,
          value: sample.value,
          unit: sample.unit,
          host: env.TELEMETRY_HOST_ID,
          recordedAt,
        })),
      });

      latest = toSnapshot(samples, env.TELEMETRY_HOST_ID, recordedAt);
      publish(latest);
    } catch (error) {
      /**
       * Telemetry collection must never take the process down. A failed read or
       * a database blip is logged and the next tick tries again; clients simply
       * see a gap in the series, which is the truthful representation of a
       * period we did not measure.
       */
      logger.error({ err: error }, 'Host metric collection failed');
    } finally {
      collecting = false;
    }
  }

  async function start(): Promise<void> {
    // Prime the rate counters, then discard the result.
    try {
      await readHost();
    } catch (error) {
      logger.warn({ err: error }, 'Host metric priming read failed; rates may lag one tick');
    }

    await tick();
    timer = setInterval(() => void tick(), env.METRICS_COLLECTION_INTERVAL_MS);
  }

  void start();

  logger.info(
    { host: env.TELEMETRY_HOST_ID, intervalMs: env.METRICS_COLLECTION_INTERVAL_MS },
    'Host metric collector started',
  );

  return {
    latest: () => latest,
    stop: () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
