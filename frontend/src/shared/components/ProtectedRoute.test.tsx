import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { useAuthStore, type SessionStatus } from '../store/authStore';
import { ProtectedRoute } from './ProtectedRoute';

/**
 * The route guard.
 *
 * Three session states, three different renders, and the middle one is the
 * whole reason this component exists. The guard it replaces knew only "user or
 * no user", so during the refresh exchange on page load it read an
 * authenticated user as anonymous and bounced them to the login screen — losing
 * their destination on every reload.
 */

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/login" element={<p>Sign in</p>} />
        <Route element={<ProtectedRoute />}>
          <Route path="/alerts" element={<p>Incident feed</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

function withStatus(status: SessionStatus) {
  useAuthStore.setState({
    status,
    user:
      status === 'authenticated'
        ? { id: 'u1', email: 'a@b.test', name: 'Ada', role: 'MEMBER' }
        : null,
    accessToken: status === 'authenticated' ? 'token' : null,
  });
}

beforeEach(() => withStatus('bootstrapping'));

describe('ProtectedRoute', () => {
  it('waits while the session is being restored', () => {
    /**
     * The case that matters. A reload starts with no access token — it lives in
     * memory only — so the app is briefly neither signed in nor signed out, and
     * treating that as signed out is what threw people back to the login page.
     */
    renderAt('/alerts');

    expect(screen.getByText(/Restoring your session/)).toBeInTheDocument();
    expect(screen.queryByText('Sign in')).not.toBeInTheDocument();
    expect(screen.queryByText('Incident feed')).not.toBeInTheDocument();
  });

  it('renders the route once the session is restored', () => {
    withStatus('authenticated');
    renderAt('/alerts');

    expect(screen.getByText('Incident feed')).toBeInTheDocument();
  });

  it('redirects to the login screen when there is genuinely no session', () => {
    withStatus('anonymous');
    renderAt('/alerts');

    expect(screen.getByText('Sign in')).toBeInTheDocument();
    expect(screen.queryByText('Incident feed')).not.toBeInTheDocument();
  });

  it('does not render the protected route even for an instant while anonymous', () => {
    // A flash of protected content is a real disclosure, not a cosmetic bug.
    withStatus('anonymous');
    const { container } = renderAt('/alerts');

    expect(container.textContent).not.toContain('Incident feed');
  });
});
