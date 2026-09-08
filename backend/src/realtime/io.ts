import type { Server as HttpServer } from 'node:http';
import { Server as SocketServer, type Socket } from 'socket.io';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import {
  accessTokenClaimsSchema,
  claimsToUser,
  type AuthenticatedUser,
} from '../modules/auth/auth.types';
import { verifyAccessToken } from '../modules/auth/tokens';

/**
 * WebSocket transport.
 *
 * Two things changed here. The socket server previously broadcast a
 * `Math.random()` payload on a timer, and it accepted every connection without
 * authentication — so anyone who could reach the port received a live feed of
 * what was presented to users as production infrastructure telemetry, with no
 * credential at all.
 *
 * Now the handshake is authenticated with the same access token the REST API
 * uses, and this module owns only the transport. Publishers (the host collector
 * and the probe scheduler) push through `RealtimePublisher`.
 */

export const RealtimeChannel = {
  Metrics: 'metrics',
  ServiceStatus: 'service:status',
  Incident: 'incident',
  Deployment: 'deployment',
} as const;

export type RealtimeChannelName = (typeof RealtimeChannel)[keyof typeof RealtimeChannel];

/** Sockets carry the authenticated principal for the life of the connection. */
type SocketData = { user: AuthenticatedUser };

export type AuthenticatedSocket = Socket<
  Record<string, never>,
  Record<string, never>,
  Record<string, never>,
  SocketData
>;

/**
 * Extracts the bearer token from the handshake.
 *
 * `auth` is the correct channel: it is sent in the Socket.IO handshake payload
 * rather than in a URL, so the token does not end up in proxy logs or in a
 * browser's history the way a query parameter would.
 */
function extractToken(socket: Socket): string | null {
  const fromAuth: unknown = socket.handshake.auth?.token;
  if (typeof fromAuth === 'string' && fromAuth.length > 0) return fromAuth;

  const header = socket.handshake.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    return header.slice('Bearer '.length).trim();
  }

  return null;
}

export function createRealtimeServer(httpServer: HttpServer): SocketServer {
  const io = new SocketServer(httpServer, {
    cors: {
      // The same allowlist the REST surface uses: the handshake is an ordinary
      // cross-origin HTTP request before it upgrades.
      origin: env.CORS_ORIGINS,
      credentials: true,
    },
  });

  io.use((socket, next) => {
    const token = extractToken(socket);

    if (!token) {
      next(new Error('Authentication required'));
      return;
    }

    const payload = verifyAccessToken(token);
    const claims = payload ? accessTokenClaimsSchema.safeParse(payload) : null;

    if (!claims?.success) {
      next(new Error('Invalid or expired access token'));
      return;
    }

    (socket.data as SocketData).user = claimsToUser(claims.data);
    next();
  });

  io.on('connection', (socket) => {
    const { user } = socket.data as SocketData;
    logger.debug({ socketId: socket.id, userId: user.id }, 'Realtime client connected');

    socket.on('disconnect', (reason) => {
      logger.debug({ socketId: socket.id, reason }, 'Realtime client disconnected');
    });
  });

  return io;
}

/**
 * Publishes to connected clients.
 *
 * Wrapping the server in a small interface keeps the collector and scheduler
 * unaware of Socket.IO, which is what lets them be exercised without a live
 * socket server, and leaves one place to add a Redis adapter when the API is
 * scaled past a single process.
 */
export type RealtimePublisher = {
  publish: <T>(channel: RealtimeChannelName, payload: T) => void;
  connectionCount: () => number;
};

export function createPublisher(io: SocketServer): RealtimePublisher {
  return {
    publish: (channel, payload) => {
      io.emit(channel, payload);
    },
    connectionCount: () => io.engine.clientsCount,
  };
}

export async function shutdownRealtimeServer(io: SocketServer): Promise<void> {
  // Disconnects every client and closes the underlying engine.
  await io.close();
}
