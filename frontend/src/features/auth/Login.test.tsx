import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../../shared/store/authStore';
import { useToastStore } from '../../shared/store/toastStore';
import Login from './Login';

/**
 * The sign-in form.
 *
 * Three things are worth pinning here, and all three were wrong before.
 *
 * The form used to arrive pre-filled with `admin@pulsara.dev` / `password`,
 * against a backend that accepted those from any address at all. It must not
 * carry credentials.
 *
 * The request has to send `credentials: 'include'`, or the browser discards the
 * refresh cookie and the user is signed out again on their next reload — a bug
 * that looks like a session problem and is actually one missing option.
 *
 * A rejected sign-in has to say so. Silence on a failed login is
 * indistinguishable from a button that does nothing.
 */

const { isGoogleSignInEnabled } = vi.hoisted(() => ({ isGoogleSignInEnabled: { value: false } }));

vi.mock('../../config/env', () => ({
  env: { VITE_API_URL: 'http://api.test' },
  get isGoogleSignInEnabled() {
    return isGoogleSignInEnabled.value;
  },
  firebaseConfig: null,
}));

vi.mock('../../shared/utils/firebase', () => ({
  getFirebaseAuth: () => ({}),
  createGoogleProvider: () => ({}),
}));

function respondWith(body: unknown, status = 200) {
  // The parameters are declared so that `mock.calls[0]` is typed as a real
  // request rather than an empty tuple.
  const mock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
  vi.stubGlobal('fetch', mock);
  return mock;
}

const session = {
  success: true,
  data: {
    user: { id: 'u1', email: 'ada@example.com', name: 'Ada', role: 'MEMBER' },
    accessToken: 'an-access-token',
  },
};

const renderLogin = () =>
  render(
    <MemoryRouter>
      <Login />
    </MemoryRouter>,
  );

beforeEach(() => {
  isGoogleSignInEnabled.value = false;
  useToastStore.setState({ toasts: [] });
});

describe('Login', () => {
  it('arrives empty, with no credentials in the box', async () => {
    renderLogin();

    expect(await screen.findByLabelText('Email')).toHaveValue('');
    expect(screen.getByLabelText('Password')).toHaveValue('');
  });

  it('signs in and stores the session in memory', async () => {
    const fetchMock = respondWith(session);
    const user = userEvent.setup();

    renderLogin();
    await user.type(screen.getByLabelText('Email'), 'ada@example.com');
    await user.type(screen.getByLabelText('Password'), 'a-real-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      expect(useAuthStore.getState().status).toBe('authenticated');
    });
    expect(useAuthStore.getState().accessToken).toBe('an-access-token');

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('http://api.test/api/auth/login');
    // Without this the refresh cookie is dropped and the next reload signs the
    // user out.
    expect(init?.credentials).toBe('include');
  });

  it('surfaces a rejected sign-in instead of failing silently', async () => {
    respondWith(
      { success: false, error: { code: 'UNAUTHENTICATED', message: 'Invalid credentials' } },
      401,
    );
    const user = userEvent.setup();

    renderLogin();
    await user.type(screen.getByLabelText('Email'), 'ada@example.com');
    await user.type(screen.getByLabelText('Password'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      expect(useToastStore.getState().toasts).toHaveLength(1);
    });
    expect(useToastStore.getState().toasts[0]?.message).toBe('Invalid credentials');
    expect(useAuthStore.getState().status).not.toBe('authenticated');
  });

  it('says the server is unreachable when it is', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    const user = userEvent.setup();

    renderLogin();
    await user.type(screen.getByLabelText('Email'), 'ada@example.com');
    await user.type(screen.getByLabelText('Password'), 'a-real-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      expect(useToastStore.getState().toasts).toHaveLength(1);
    });
  });

  it('hides the Google button where the deployment has no Firebase project', () => {
    // A button guaranteed to fail is worse than no button.
    renderLogin();
    expect(screen.queryByRole('button', { name: /Google/ })).not.toBeInTheDocument();
  });

  it('offers the Google button where it is configured', async () => {
    isGoogleSignInEnabled.value = true;
    renderLogin();

    expect(await screen.findByRole('button', { name: /Google/ })).toBeInTheDocument();
  });
});
