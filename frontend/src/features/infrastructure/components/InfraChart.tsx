import * as React from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { RealtimeChannel } from '../../../shared/api/socket';
import type { HostSnapshot, MetricSeriesMeta, MetricSeriesPoint } from '../../../shared/api/types';
import { useApi } from '../../../shared/api/useApi';
import { useRealtime } from '../../../shared/api/useRealtime';
import { Card, CardContent, CardHeader, CardTitle } from '../../../shared/components/Card';

/**
 * Host telemetry chart.
 *
 * Two changes of substance from the original version:
 *
 * 1. The data is real. It was previously fed by a `Math.random()` generator on
 *    the server, bounded to look plausible, so the chart could never show a
 *    machine actually in trouble.
 * 2. History is loaded from storage. The chart used to hold fifteen points that
 *    existed only in this component's state and vanished on reload, so it could
 *    never answer "what happened five minutes ago" — the single most common
 *    question asked of a telemetry chart.
 *
 * Recorded history is fetched through the shared API client, and the socket
 * appends live samples on top of it.
 */

/** Default history window; the Infrastructure view offers wider ones. */
export const DEFAULT_WINDOW_MINUTES = 30;
/** Upper bound on points requested; the server buckets the range to fit. */
const HISTORY_MAX_POINTS = 180;
/**
 * Cap on points held in memory. Without it, a dashboard left open overnight
 * accumulates samples until the tab is unusable.
 */
const MAX_POINTS_IN_MEMORY = 720;

const MS_PER_MINUTE = 60_000;

type ChartPoint = {
  timestamp: string;
  timeLabel: string;
  cpu: number | null;
  memory: number | null;
  disk: number | null;
};

function toTimeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function fromSeriesPoint(point: MetricSeriesPoint): ChartPoint {
  return {
    timestamp: point.timestamp,
    timeLabel: toTimeLabel(point.timestamp),
    cpu: point.cpu ?? null,
    memory: point.memory ?? null,
    disk: point.disk ?? null,
  };
}

function fromSnapshot(snapshot: HostSnapshot): ChartPoint {
  return {
    timestamp: snapshot.timestamp,
    timeLabel: toTimeLabel(snapshot.timestamp),
    cpu: snapshot.cpu,
    memory: snapshot.memory,
    disk: snapshot.disk,
  };
}

export function InfraChart({ windowMinutes = DEFAULT_WINDOW_MINUTES }: { windowMinutes?: number }) {
  /**
   * The window is anchored when the range changes rather than on every render,
   * so the request path is stable and the history is fetched once per window
   * instead of on a loop.
   */
  const historyPath = React.useMemo(() => {
    const to = new Date();
    const from = new Date(to.getTime() - windowMinutes * MS_PER_MINUTE);
    const query = new URLSearchParams({
      from: from.toISOString(),
      to: to.toISOString(),
      types: 'cpu,memory,disk',
      maxPoints: String(HISTORY_MAX_POINTS),
    });
    return `/metrics/series?${query.toString()}`;
  }, [windowMinutes]);

  const history = useApi<MetricSeriesPoint[], MetricSeriesMeta>(historyPath);

  const [live, setLive] = React.useState<ChartPoint[]>([]);
  const [latest, setLatest] = React.useState<HostSnapshot | null>(null);

  /**
   * Live samples are discarded when the window changes, because the refetch
   * that follows already covers the period they came from. Adjusting during
   * render rather than in an effect avoids a frame in which the chart shows the
   * new window's history with the old window's tail glued onto it.
   */
  const [renderedPath, setRenderedPath] = React.useState(historyPath);
  if (renderedPath !== historyPath) {
    setRenderedPath(historyPath);
    setLive([]);
  }

  const { streamError } = useRealtime<HostSnapshot>(RealtimeChannel.Metrics, (snapshot) => {
    setLatest(snapshot);
    setLive((previous) => {
      const next = [...previous, fromSnapshot(snapshot)];
      return next.length > MAX_POINTS_IN_MEMORY
        ? next.slice(next.length - MAX_POINTS_IN_MEMORY)
        : next;
    });
  });

  const points = React.useMemo(() => {
    const recorded = (history.data ?? []).map(fromSeriesPoint);
    const combined = [...recorded, ...live];
    return combined.length > MAX_POINTS_IN_MEMORY
      ? combined.slice(combined.length - MAX_POINTS_IN_MEMORY)
      : combined;
  }, [history.data, live]);

  const collectorDisabled = history.meta?.collectorEnabled === false;

  return (
    <Card className="col-span-1 md:col-span-2 lg:col-span-3">
      <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
        <div>
          <CardTitle>Host Telemetry</CardTitle>
          <p className="text-xs text-muted mt-1">
            {latest ? `Live from ${latest.host}` : 'Recorded host metrics'}
            {history.meta ? ` · ${history.meta.bucketSeconds}s buckets` : ''}
          </p>
        </div>
        {latest && (
          <div className="flex gap-4 text-xs font-mono">
            <span className="text-accent">CPU {latest.cpu?.toFixed(1) ?? '—'}%</span>
            <span className="text-[#8884d8]">RAM {latest.memory?.toFixed(1) ?? '—'}%</span>
            <span className="text-muted">DISK {latest.disk?.toFixed(1) ?? '—'}%</span>
          </div>
        )}
      </CardHeader>
      <CardContent>
        <div className="h-[240px] w-full pt-4">
          {history.isLoading ? (
            <div className="h-full flex items-center justify-center text-muted text-sm">
              Loading recorded telemetry…
            </div>
          ) : history.error ? (
            <div
              className="h-full flex items-center justify-center text-danger text-sm"
              role="alert"
            >
              {history.error}
            </div>
          ) : points.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-muted text-sm gap-1">
              {/* Distinguishes "nothing recorded" from "collector switched off",
                  which look identical if all the client shows is an empty chart. */}
              <span>No telemetry recorded for this window.</span>
              {collectorDisabled && (
                <span className="text-xs">The host metric collector is disabled.</span>
              )}
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={points} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorCpu" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--accent)" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="var(--accent)" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="colorMem" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#8884d8" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#8884d8" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                <XAxis dataKey="timeLabel" stroke="var(--muted)" fontSize={10} tickLine={false} />
                <YAxis
                  stroke="var(--muted)"
                  fontSize={10}
                  tickLine={false}
                  domain={[0, 100]}
                  unit="%"
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'var(--surface)',
                    borderColor: 'var(--border)',
                  }}
                  labelStyle={{ color: 'white' }}
                  itemStyle={{ fontSize: 12 }}
                />
                {/* connectNulls is off on purpose: a gap in the series means a
                    period that was not measured, and bridging it would draw a
                    line through time nobody observed. */}
                <Area
                  type="monotone"
                  dataKey="cpu"
                  name="CPU (%)"
                  stroke="var(--accent)"
                  fillOpacity={1}
                  fill="url(#colorCpu)"
                  strokeWidth={2}
                  connectNulls={false}
                  isAnimationActive={false}
                />
                <Area
                  type="monotone"
                  dataKey="memory"
                  name="Memory (%)"
                  stroke="#8884d8"
                  fillOpacity={1}
                  fill="url(#colorMem)"
                  strokeWidth={2}
                  connectNulls={false}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
        {streamError && (
          <p className="text-xs text-warning mt-2" role="status">
            Live stream disconnected: {streamError}. Showing recorded history only.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
