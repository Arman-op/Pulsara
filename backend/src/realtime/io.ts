import type { Server as HttpServer } from 'node:http';
import { Server as SocketServer } from 'socket.io';
import { env } from '../config/env';
import { logger } from '../lib/logger';

/**
 * WebSocket transport.
 *
 * The previous implementation broadcast a `Math.random()` payload on a timer to
 * every connected socket, authenticated or not. That generator is gone: this
 * module is now only responsible for the transport itself, and publishers
 * attach to it. Real telemetry is produced by the collector introduced in the
 * telemetry change, and access control is applied in the authentication change.
 */

/** Channel names, so publisher and subscriber cannot drift apart on a typo. */
export const RealtimeChannel = {
  Metrics: 'metrics',
  ServiceStatus: 'service:status',
  Incident: 'incident',
  Deployment: 'deployment',
} as const;

export type RealtimeChannelName = (typeof RealtimeChannel)[keyof typeof RealtimeChannel];

export function createRealtimeServer(httpServer: HttpServer): SocketServer {
  const io = new SocketServer(httpServer, {
    cors: {
      // The same allowlist the REST surface uses; the handshake is a normal
      // cross-origin HTTP request before it upgrades.
      origin: env.CORS_ORIGINS,
      credentials: true,
    },
  });

  io.on('connection', (socket) => {
    logger.debug({ socketId: socket.id }, 'Realtime client connected');

    socket.on('disconnect', (reason) => {
      logger.debug({ socketId: socket.id, reason }, 'Realtime client disconnected');
    });
  });

  return io;
}

export async function shutdownRealtimeServer(io: SocketServer): Promise<void> {
  // Disconnects every client and closes the underlying engine.
  await io.close();
}
