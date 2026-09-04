import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostSnapshot } from '../../../shared/api/types';
import { useAuthStore } from '../../../shared/store/authStore';
import { InfraChart } from './InfraChart';

/**
 * The telemetry chart.
 *
 * Recharts renders through a ResponsiveContainer that measures its parent, and
 * jsdom reports every element as zero by zero — so the SVG never appears and
 * asserting on plotted paths would be asserting on the mock. What is worth
 * testing here is everything around the plot, and it is the part that carries
 * the meaning: whether the component can tell "no data recorded" from "the
 * collector is switched off", whether it shows a live reading, and whether it
 * admits when the stream has dropped.
 *
 * The chart itself is asserted through the data it is handed, which is the
 * boundary this component actually owns.
 */

const CHART_DATA = vi.hoisted(() => ({ current: [] as Record<string, unknown>[] }));

vi.mock('recharts', async () => {
  const actual = await vi.importActual<typeof import('recharts')>('recharts');
  return {
    ...actual,
    // Captures what the chart was given, and renders nothing: the SVG cannot
    // lay out in jsdom anyway.
    AreaChart: ({ data }: { data: Record<string, unknown>[] }) => {
      CHART_DATA.current = data;
      return <div data-testid="chart" />;
    },
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  };
});

const realtime = vi.hoisted(() => ({ handler: null as ((snapshot: unknown) => void) | null }));

vi.mock('../../../shared/api/useRealtime', () => ({
  useRealtime: (_channel: string, onEvent: (snapshot: unknown) => void) => {
    realtime.handler = onEvent;
    return { streamError: null };
  },
}));

function respondWith(body: unknown, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    ),
  );
}

const series = (points: { timestamp: string; cpu: number | null }[]) => ({
  success: true,
  data: points.map((point) => ({ ...point, memory: 50, disk: 20 })),
  meta: {
    host: 'test-host',
    bucketSeconds: 30,
    collectorEnabled: true,
    types: [],
    from: '',
    to: '',
  },
});

beforeEach(() => {
  CHART_DATA.current = [];
  realtime.handler = null;
  useAuthStore.setState({
    user: { id: 'u1', email: 'a@b.test', name: 'Ada', role: 'ADMIN' },
    accessToken: 'token',
    status: 'authenticated',
  });
});

describe('InfraChart', () => {
  it('plots the recorded history it was given', async () => {
    respondWith(series([{ timestamp: '2026-01-01T10:00:00Z', cpu: 12.5 }]));

    render(<InfraChart />);

    expect(await screen.findByTestId('chart')).toBeInTheDocument();
    expect(CHART_DATA.current).toHaveLength(1);
    expect(CHART_DATA.current[0]).toMatchObject({ cpu: 12.5 });
  });

  it('keeps a gap in the series as a gap', async () => {
    /**
     * A null is a period nobody measured. It has to survive as null all the way
     * to the chart, because `connectNulls` is off precisely so the line does
     * not get drawn through time that was never observed.
     */
    respondWith(
      series([
        { timestamp: '2026-01-01T10:00:00Z', cpu: 10 },
        { timestamp: '2026-01-01T10:00:30Z', cpu: null },
        { timestamp: '2026-01-01T10:01:00Z', cpu: 30 },
      ]),
    );

    render(<InfraChart />);
    await screen.findByTestId('chart');

    expect(CHART_DATA.current.map((point) => point.cpu)).toEqual([10, null, 30]);
  });

  it('appends live samples to the recorded history', async () => {
    respondWith(series([{ timestamp: '2026-01-01T10:00:00Z', cpu: 10 }]));

    render(<InfraChart />);
    await screen.findByTestId('chart');
    expect(CHART_DATA.current).toHaveLength(1);

    const live: HostSnapshot = {
      host: 'test-host',
      cpu: 44,
      memory: 61,
      disk: 20,
      networkRx: 1000,
      networkTx: 500,
      load1m: 0.4,
      timestamp: '2026-01-01T10:00:02Z',
    };

    realtime.handler?.(live);

    expect(await screen.findByText(/CPU 44.0%/)).toBeInTheDocument();
    expect(CHART_DATA.current).toHaveLength(2);
  });

  it('distinguishes nothing recorded from a collector that is switched off', async () => {
    /**
     * Both are an empty chart, and only one of them is a configuration problem.
     * Showing the same blank panel for each is how somebody spends an afternoon
     * looking for a bug in a feature nobody enabled.
     */
    respondWith({
      success: true,
      data: [],
      meta: { host: 'test-host', bucketSeconds: 30, collectorEnabled: false },
    });

    render(<InfraChart />);

    expect(await screen.findByText(/No telemetry recorded/)).toBeInTheDocument();
    expect(screen.getByText(/collector is disabled/)).toBeInTheDocument();
  });

  it('stays quiet about the collector when it is simply a quiet window', async () => {
    respondWith({
      success: true,
      data: [],
      meta: { host: 'test-host', bucketSeconds: 30, collectorEnabled: true },
    });

    render(<InfraChart />);

    expect(await screen.findByText(/No telemetry recorded/)).toBeInTheDocument();
    expect(screen.queryByText(/collector is disabled/)).not.toBeInTheDocument();
  });

  it('reports a failed request as an error rather than as an empty chart', async () => {
    respondWith(
      { success: false, error: { code: 'UPSTREAM_UNAVAILABLE', message: 'Database unreachable' } },
      503,
    );

    render(<InfraChart />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Database unreachable');
  });
});
