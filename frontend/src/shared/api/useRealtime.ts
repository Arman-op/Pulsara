import * as React from 'react';
import { useAuthStore } from '../store/authStore';
import { createAuthenticatedSocket } from './socket';

/**
 * Subscribe a component to one realtime channel.
 *
 * The access token lives in memory and is rotated roughly every fifteen
 * minutes, and Socket.IO authenticates once at handshake time — so a connection
 * opened with the previous token would keep working until it dropped, then fail
 * every reconnect attempt. Re-opening the socket when the token changes is what
 * keeps a long-lived dashboard connected.
 *
 * Keeping that here rather than in each chart is the point: screens should not
 * need to know the token exists, and none of them do any more.
 */
export function useRealtime<T>(
  channel: string,
  onEvent: (payload: T) => void,
): { streamError: string | null } {
  const accessToken = useAuthStore((store) => store.accessToken);
  const [streamError, setStreamError] = React.useState<string | null>(null);

  /**
   * The handler is held in a ref so that an inline arrow function — which is a
   * new value on every render — does not tear the socket down and rebuild it
   * sixty times a second.
   */
  const handler = React.useRef(onEvent);
  React.useEffect(() => {
    handler.current = onEvent;
  });

  React.useEffect(() => {
    if (!accessToken) return;

    const socket = createAuthenticatedSocket();
    if (!socket) return;

    socket.on('connect', () => setStreamError(null));
    socket.on('connect_error', (error: Error) => setStreamError(error.message));
    socket.on(channel, (payload: T) => handler.current(payload));

    return () => {
      socket.close();
    };
  }, [channel, accessToken]);

  return { streamError };
}
