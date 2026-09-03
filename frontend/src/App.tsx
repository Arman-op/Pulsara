import * as React from 'react';
import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { Sidebar } from './app/Sidebar';
import Alerts from './features/alerts/Alerts';
import Login from './features/auth/Login';
import Dashboard from './features/dashboard/Dashboard';
import Infrastructure from './features/infrastructure/Infrastructure';
import NotFound from './features/notfound/NotFound';
import Pipelines from './features/pipelines/Pipelines';
import Settings from './features/settings/Settings';
import Users from './features/users/Users';
import { bootstrapSession } from './shared/api/client';
import { ErrorBoundary } from './shared/components/ErrorBoundary';
import { FullPageSpinner } from './shared/components/FullPageSpinner';
import { ProtectedRoute } from './shared/components/ProtectedRoute';
import { ToastViewport } from './shared/components/ToastViewport';
import { useAuthStore } from './shared/store/authStore';

function AppLayout() {
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background">
      <Sidebar />
      <main className="flex-1 overflow-y-auto p-6 lg:p-10">
        {/* Scoped to the content area so a failing screen does not take the
            navigation down with it. */}
        <ErrorBoundary>
          <Outlet />
        </ErrorBoundary>
      </main>
    </div>
  );
}

/**
 * Routes only an administrator may open.
 *
 * The server is the authority and rejects the underlying requests regardless;
 * this exists so a VIEWER is not shown a page whose every request will fail.
 */
function AdminRoute() {
  const role = useAuthStore((store) => store.user?.role);
  return role === 'ADMIN' ? <Outlet /> : <Navigate to="/" replace />;
}

export default function App() {
  const status = useAuthStore((store) => store.status);

  /**
   * Exchange the HttpOnly refresh cookie for an access token before rendering.
   *
   * This is what replaces reading a token out of `localStorage`. Until it
   * settles the app shows a splash, so an authenticated user reloading the page
   * is never flashed the login screen.
   */
  React.useEffect(() => {
    void bootstrapSession();
  }, []);

  if (status === 'bootstrapping') {
    return <FullPageSpinner label="Restoring your session…" />;
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />

        <Route element={<ProtectedRoute />}>
          <Route element={<AppLayout />}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/pipelines" element={<Pipelines />} />
            <Route path="/infrastructure" element={<Infrastructure />} />
            <Route path="/alerts" element={<Alerts />} />
            <Route path="/settings" element={<Settings />} />
            <Route element={<AdminRoute />}>
              <Route path="/users" element={<Users />} />
            </Route>
            {/* Catch-all inside the shell, so a mistyped URL keeps navigation. */}
            <Route path="*" element={<NotFound />} />
          </Route>
        </Route>
      </Routes>

      <ToastViewport />
    </BrowserRouter>
  );
}
