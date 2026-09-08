import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Incident, Role } from '../../shared/api/types';
import { useAuthStore } from '../../shared/store/authStore';
import { useToastStore } from '../../shared/store/toastStore';
import Alerts from './Alerts';

/**
 * The incident feed, and the form for raising one by hand.
 *
 * Two things are worth pinning. The feed has to distinguish what a machine
 * observed from what a person filed, because the two mean different things when
 * deciding what to do about them. And the form has to be a real write — the
 * screen it replaces was a static list, and a form that posts nothing looks
 * identical to one that works until somebody reloads.
 */

const incident = (overrides: Partial<Incident> = {}): Incident => ({
  id: 'i1',
  title: 'Checkout is failing',
  description: 'Returning 500s for about a tenth of requests',
  severity: 'CRITICAL',
  status: 'INVESTIGATING',
  source: 'AUTOMATED',
  isOpen: true,
  service: { id: 's1', name: 'Checkout', status: 'OFFLINE' },
  assignee: null,
  resolvedAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...overrides,
});

type Route = { match: string; body: unknown; status?: number };

/** Records every write, so a form can be shown to have actually posted. */
const writes: { url: string; init: RequestInit }[] = [];

function respondWith(routes: Route[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method && init.method !== 'GET') writes.push({ url, init });

      const route = routes.find((candidate) => url.includes(candidate.match));
      const body = route?.body ?? { success: true, data: [] };

      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: route?.status ?? 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
}

const ok = (data: unknown) => ({ success: true, data });

function signedInAs(role: Role) {
  useAuthStore.setState({
    user: { id: 'u1', email: 'a@b.test', name: 'Ada', role },
    accessToken: 'token',
    status: 'authenticated',
  });
}

beforeEach(() => {
  writes.length = 0;
  useToastStore.setState({ toasts: [] });
  signedInAs('MEMBER');
});

describe('the incident feed', () => {
  it('says the feed is empty rather than showing nothing', async () => {
    respondWith([{ match: '/incidents', body: ok([]) }]);

    render(<Alerts />);

    expect(await screen.findByText('No open incidents')).toBeInTheDocument();
    // And says what would fill it, so empty reads as working rather than broken.
    expect(screen.getByText(/alerting engine opens one automatically/)).toBeInTheDocument();
  });

  it('distinguishes what a machine found from what a person filed', async () => {
    respondWith([
      {
        match: '/incidents',
        body: ok([
          incident({ id: 'i1', title: 'Machine found this', source: 'AUTOMATED' }),
          incident({ id: 'i2', title: 'Person filed this', source: 'MANUAL' }),
        ]),
      },
    ]);

    render(<Alerts />);

    expect(await screen.findByText('Machine found this')).toBeInTheDocument();
    expect(screen.getByText('auto-detected')).toBeInTheDocument();
    expect(screen.getByText('reported')).toBeInTheDocument();
  });

  it('surfaces a failed load as an error rather than an empty feed', async () => {
    respondWith([
      {
        match: '/incidents',
        body: { success: false, error: { code: 'UPSTREAM_UNAVAILABLE', message: 'Database down' } },
        status: 503,
      },
    ]);

    render(<Alerts />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Database down');
  });
});

describe('raising an incident by hand', () => {
  it('is offered to a member and hidden from a viewer', async () => {
    respondWith([{ match: '/incidents', body: ok([]) }]);

    const { unmount } = render(<Alerts />);
    expect(await screen.findByRole('button', { name: /Open an incident/ })).toBeInTheDocument();
    unmount();

    // The server refuses a VIEWER regardless; hiding it avoids offering a
    // control whose every request would be rejected.
    signedInAs('VIEWER');
    render(<Alerts />);
    await screen.findByText('No open incidents');
    expect(screen.queryByRole('button', { name: /Open an incident/ })).not.toBeInTheDocument();
  });

  it('posts what was typed', async () => {
    respondWith([
      { match: '/services', body: ok([{ id: 's1', name: 'Checkout' }]) },
      { match: '/incidents', body: ok([]) },
    ]);
    const user = userEvent.setup();

    render(<Alerts />);
    await user.click(await screen.findByRole('button', { name: /Open an incident/ }));

    await user.type(
      await screen.findByLabelText('What is happening?'),
      'Customers cannot check out',
    );
    await user.click(screen.getByRole('button', { name: 'Open incident' }));

    await waitFor(() => expect(writes).toHaveLength(1));

    const write = writes[0];
    expect(write?.url).toContain('/api/incidents');
    expect(write?.init.method).toBe('POST');
    expect(JSON.parse(String(write?.init.body))).toMatchObject({
      title: 'Customers cannot check out',
      severity: 'MEDIUM',
    });
  });

  it('omits an unselected service rather than sending an empty one', async () => {
    // The server validates a service id as a UUID, and "" is not one.
    respondWith([
      { match: '/services', body: ok([]) },
      { match: '/incidents', body: ok([]) },
    ]);
    const user = userEvent.setup();

    render(<Alerts />);
    await user.click(await screen.findByRole('button', { name: /Open an incident/ }));
    await user.type(await screen.findByLabelText('What is happening?'), 'Something is wrong');
    await user.click(screen.getByRole('button', { name: 'Open incident' }));

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(JSON.parse(String(writes[0]?.init.body))).not.toHaveProperty('serviceId');
  });

  it('will not submit without a title', async () => {
    respondWith([
      { match: '/services', body: ok([]) },
      { match: '/incidents', body: ok([]) },
    ]);
    const user = userEvent.setup();

    render(<Alerts />);
    await user.click(await screen.findByRole('button', { name: /Open an incident/ }));

    const submit = await screen.findByRole('button', { name: 'Open incident' });
    expect(submit).toBeDisabled();
  });

  it('reports a rejected write instead of appearing to succeed', async () => {
    respondWith([
      { match: '/services', body: ok([]) },
      {
        match: '/incidents',
        body: { success: false, error: { code: 'FORBIDDEN', message: 'Not permitted' } },
        status: 403,
      },
    ]);
    const user = userEvent.setup();

    render(<Alerts />);
    await user.click(await screen.findByRole('button', { name: /Open an incident/ }));
    await user.type(await screen.findByLabelText('What is happening?'), 'Something is wrong');
    await user.click(screen.getByRole('button', { name: 'Open incident' }));

    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
    expect(useToastStore.getState().toasts[0]?.message).toBe('Not permitted');
  });
});

describe('the detail drawer', () => {
  it('shows the timeline, which is what makes a postmortem possible', async () => {
    respondWith([
      {
        match: '/incidents/i1',
        body: ok({
          ...incident(),
          events: [
            {
              id: 1,
              kind: 'OPENED',
              message: 'Checkout stopped answering',
              createdAt: '2026-01-01T10:00:00Z',
              actorId: null,
            },
            {
              id: 2,
              kind: 'SEVERITY_CHANGED',
              message: 'Raised to CRITICAL',
              createdAt: '2026-01-01T10:05:00Z',
              actorId: null,
            },
          ],
        }),
      },
      { match: '/incidents', body: ok([incident()]) },
    ]);
    const user = userEvent.setup();

    render(<Alerts />);
    await user.click(await screen.findByText('Checkout is failing'));

    const timeline = await screen.findByRole('list');
    expect(within(timeline).getByText('Checkout stopped answering')).toBeInTheDocument();
    expect(within(timeline).getByText('Raised to CRITICAL')).toBeInTheDocument();
  });
});
