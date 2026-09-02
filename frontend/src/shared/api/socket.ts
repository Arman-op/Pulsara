import { io, type Socket } from 'socket.io-client';
import { env } from '../../config/env';
import { useAuthStore } from '../store/authStore';

/**
 * Authenticated realtime connection.
 *
 * The server now requires a valid access token in the Socket.IO handshake, so
 * the token is supplied through `auth` rather than as a query parameter: the
 * handshake payload does not end up in proxy logs or browser history the way a
 * URL does.
 *
 * `autoConnect` is disabled so the caller connects only once a token exists.
 * Connecting first and authenticating later would produce a guaranteed
 * rejection on every page load before sign-in.
 */
export const RealtimeChannel = {
  Metrics: 'metrics',
  ServiceStatus: 'service:status',
} as const;

export function createAuthenticatedSocket(): Socket | null {
  const { accessToken } = useAuthStore.getState();
  if (!accessToken) return null;

  return io(env.VITE_API_URL, {
    auth: { token: accessToken },
    withCredentials: true,
    autoConnect: true,
    // The access token is short-lived. Reconnecting forever with a token the
    // server has already rejected is just noise, so give up and let the caller
    // surface the disconnection.
    reconnectionAttempts: 5,
  });
}
