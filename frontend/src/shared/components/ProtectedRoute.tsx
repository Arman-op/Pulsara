import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import { FullPageSpinner } from './FullPageSpinner';

/**
 * Route guard.
 *
 * The three session states are distinct and must be rendered differently. The
 * previous guard only knew "user or no user", so during the page-load refresh
 * exchange it treated an authenticated user as anonymous and bounced them to
 * the login screen — losing their destination on every reload.
 */
export function ProtectedRoute() {
  const status = useAuthStore((store) => store.status);
  const location = useLocation();

  if (status === 'bootstrapping') {
    return <FullPageSpinner label="Restoring your session…" />;
  }

  if (status === 'anonymous') {
    // `state.from` lets the login screen return the user where they were going.
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <Outlet />;
}
