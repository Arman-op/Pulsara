import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Service } from '../../../shared/api/types';
import { useAuthStore } from '../../../shared/store/authStore';
import { SystemHealthMap } from './SystemHealthMap';

/**
 * The rule this component exists to obey: a metric nobody measured is rendered
 * as an em dash, never as a number.
 *
 * The original version fell back to a hard-coded array of six healthy-looking
 * services whenever its request failed, which made an unreachable API and a
 * healthy fleet indistinguishable. These cases assert the three states it must
 * keep apart — measured, unmeasured, and unreachable.
 */

vi.mock('../../../shared/api/useRealtime', () => ({
  // The socket is a separate concern with its own seam; here it must simply not
  // open a connection.
  useRealtime: () => ({ streamError: null }),
}));

const measured: Service = {
  id: 'svc-1',
  name: 'Pulsara API',
  description: 'The API itself',
  status: 'ONLINE',
  probeType: 'HTTP',
  probeTarget: 'http://localhost:4000/api/health',
  probeIntervalSeconds: 30,
  isMonitored: true,
  updatedAt: '2026-01-01T10:00:00Z',
  uptimePercent: 99.95,
  latencyP50Ms: 12,
  latencyP95Ms: 48,
  sampleCount: 240,
  lastLatencyMs: 12,
  lastCheckedAt: '2026-01-01T10:00:00Z',
};

const unmeasured: Service = {
  ...measured,
  id: 'svc-2',
  name: 'Pulsara Web',
  uptimePercent: null,
  latencyP50Ms: null,
  latencyP95Ms: null,
  sampleCount: 0,
  lastLatencyMs: null,
  lastCheckedAt: null,
};

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

beforeEach(() => {
  useAuthStore.setState({
    user: { id: 'u1', email: 'a@b.test', name: 'Ada', role: 'ADMIN' },
    accessToken: 'token',
    status: 'authenticated',
  });
});

describe('SystemHealthMap', () => {
  it('shows measured uptime and latency to two decimals', async () => {
    respondWith({
      success: true,
      data: [measured],
      meta: { uptimeWindowHours: 24, probesEnabled: true },
    });

    render(<SystemHealthMap />);

    // Two decimals: the difference between 99.95% and 99.99% is about
    // seventeen minutes of monthly downtime, which whole percent hides.
    expect(await screen.findByText('99.95% · 12ms')).toBeInTheDocument();
    expect(screen.getByText(/Uptime over the last 24h/)).toBeInTheDocument();
  });

  it('renders an unmeasured service as an em dash and says so', async () => {
    respondWith({
      success: true,
      data: [unmeasured],
      meta: { uptimeWindowHours: 24, probesEnabled: true },
    });

    render(<SystemHealthMap />);

    expect(await screen.findByText('— · —')).toBeInTheDocument();
    expect(screen.getByText('not yet measured')).toBeInTheDocument();
  });

  it('says probing is disabled rather than implying everything is fine', async () => {
    respondWith({
      success: true,
      data: [unmeasured],
      meta: { uptimeWindowHours: 24, probesEnabled: false },
    });

    render(<SystemHealthMap />);

    expect(await screen.findByText(/probing is disabled/)).toBeInTheDocument();
  });

  it('reports a failed request as an error, never as a healthy fleet', async () => {
    respondWith(
      { success: false, error: { code: 'UPSTREAM_UNAVAILABLE', message: 'Database unreachable' } },
      503,
    );

    render(<SystemHealthMap />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Database unreachable');
    expect(screen.queryByText(/99\./)).not.toBeInTheDocument();
  });

  it('distinguishes an empty catalogue from a broken one', async () => {
    respondWith({ success: true, data: [], meta: { uptimeWindowHours: 24, probesEnabled: true } });

    render(<SystemHealthMap />);

    expect(await screen.findByText(/No services are registered yet/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
