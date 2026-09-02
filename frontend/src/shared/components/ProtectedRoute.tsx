import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
export function ProtectedRoute() {
  const { user } = useAuthStore();
  const location = useLocation();
  if (!user || !useAuthStore.getState().accessToken) {
    // If we have a user but no access token, clear everything (invalid state)
    if (user) {
      useAuthStore.getState().logout();
    }
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
  return <Outlet />;
}
