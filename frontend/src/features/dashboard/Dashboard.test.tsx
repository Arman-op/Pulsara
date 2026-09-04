import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Service } from '../../shared/api/types';
import { useAuthStore } from '../../shared/store/authStore';
import Dashboard from './Dashboard';

/**
 * The summary tiles.
 *
 * One rule here is worth more than the rest of the screen put together: fleet
 * uptime averages only over services that have actually been probed. Counting
 * an unmeasured service as 100% inflates the headline figure with data that
 * does not exist, and the headline figure is the number somebody glances at and
 * repeats in a meeting.
 */

vi.mock('../infrastructure/components/InfraChart', () => ({
  // The chart has its own suite; here it would only add a Recharts layout that
  // jsdom cannot perform.
  InfraChart: () => <div data-testid="infra-chart" />,
}));

const measured = (overrides: Partial<Service>): Service => ({
  id: crypto.randomUUID(),
  name: 'A service',
  description: null,
  status: 'ONLINE',
  probeType: 'HTTP',
  probeTarget: 'https://example.test/health',
  probeIntervalSeconds: 30,
  isMonitored: true,
  updatedAt: '2026-01-01T10:00:00Z',
  uptimePercent: 100,
  latencyP50Ms: 10,
  latencyP95Ms: 20,
  lastLatencyMs: 10,
  sampleCount: 100,
  lastCheckedAt: '2026-01-01T10:00:00Z',
  ...overrides,
});

/** Answers each endpoint the dashboard polls. */
function respondWith(routes: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const match = Object.keys(routes).find((path) => url.includes(path));
      const body = match ? routes[match] : { success: true, data: [] };

      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
}

const ok = (data: unknown) => ({ success: true, data });

const renderDashboard = () =>
  render(
    <MemoryRouter>
      <Dashboard />
    </MemoryRouter>,
  );

beforeEach(() => {
  useAuthStore.setState({
    user: { id: 'u1', email: 'a@b.test', name: 'Ada', role: 'ADMIN' },
    accessToken: 'token',
    status: 'authenticated',
  });
});

describe('Dashboard', () => {
  it('averages uptime only over services that have been probed', async () => {
    /**
     * Two services, one never checked. The average must be of the one real
     * reading, not of one reading and an invented 100%.
     */
    respondWith({
      '/services': ok([
        measured({ name: 'Measured', uptimePercent: 90, sampleCount: 50 }),
        measured({
          name: 'Never checked',
          uptimePercent: null,
          sampleCount: 0,
          lastCheckedAt: null,
        }),
      ]),
      '/incidents/summary': ok({ total: 0, open: 0, resolved: 0, openBySeverity: {} }),
      '/deployments/stats': ok({
        sampled: 0,
        finished: 0,
        succeeded: 0,
        failed: 0,
        successRatePercent: null,
        medianDurationSeconds: null,
      }),
    });

    renderDashboard();

    expect(await screen.findByText('90.00%')).toBeInTheDocument();
    expect(screen.getByText(/across 1 measured service$/)).toBeInTheDocument();
  });

  it('shows an em dash when nothing has been measured at all', async () => {
    respondWith({
      '/services': ok([measured({ uptimePercent: null, sampleCount: 0, lastCheckedAt: null })]),
      '/incidents/summary': ok({ total: 0, open: 0, resolved: 0, openBySeverity: {} }),
    });

    renderDashboard();

    expect(await screen.findByText('not yet measured')).toBeInTheDocument();
    expect(screen.queryByText(/100\.00%/)).not.toBeInTheDocument();
  });

  it('counts services online against the total', async () => {
    respondWith({
      '/services': ok([
        measured({ name: 'Up', status: 'ONLINE' }),
        measured({ name: 'Down', status: 'OFFLINE' }),
      ]),
      '/incidents/summary': ok({ total: 0, open: 0, resolved: 0, openBySeverity: {} }),
    });

    renderDashboard();

    expect(await screen.findByText('1/2')).toBeInTheDocument();
  });

  it('reports no deployment history rather than a success rate of zero', async () => {
    // Zero per cent success and "nothing has run" are very different claims.
    respondWith({
      '/services': ok([]),
      '/incidents/summary': ok({ total: 0, open: 0, resolved: 0, openBySeverity: {} }),
      '/deployments/stats': ok({
        sampled: 0,
        finished: 0,
        succeeded: 0,
        failed: 0,
        successRatePercent: null,
        medianDurationSeconds: null,
      }),
    });

    renderDashboard();

    expect(await screen.findByText('no runs recorded')).toBeInTheDocument();
  });

  it('lists open incidents and breaks them down by severity', async () => {
    respondWith({
      '/services': ok([]),
      '/incidents/summary': ok({
        total: 3,
        open: 2,
        resolved: 1,
        openBySeverity: { CRITICAL: 1, LOW: 1 },
      }),
      '/incidents?isOpen=true&limit=5': ok([
        {
          id: 'i1',
          title: 'Checkout is failing',
          severity: 'CRITICAL',
          status: 'INVESTIGATING',
          source: 'AUTOMATED',
          isOpen: true,
          service: { id: 's1', name: 'Checkout', status: 'OFFLINE' },
          assignee: null,
          resolvedAt: null,
          description: null,
          createdAt: '2026-01-01T10:00:00Z',
          updatedAt: '2026-01-01T10:00:00Z',
        },
      ]),
    });

    renderDashboard();

    expect(await screen.findByText('Checkout is failing')).toBeInTheDocument();
    expect(screen.getByText('1 critical')).toBeInTheDocument();
    expect(screen.getByText(/1 resolved to date/)).toBeInTheDocument();
  });

  it('says the feed is empty rather than showing nothing at all', async () => {
    respondWith({
      '/services': ok([]),
      '/incidents/summary': ok({ total: 0, open: 0, resolved: 0, openBySeverity: {} }),
    });

    renderDashboard();

    expect(await screen.findByText(/No open incidents/)).toBeInTheDocument();
  });
});
