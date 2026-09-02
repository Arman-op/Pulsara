import { createServer } from 'node:http';
import { SHUTDOWN_GRACE_PERIOD_MS } from './config/constants';
import { env } from './config/env';
import { app } from './app';
import { prisma } from './db/prisma';
import { logger } from './lib/logger';
import { createRealtimeServer, shutdownRealtimeServer } from './realtime/io';

const httpServer = createServer(app);
const io = createRealtimeServer(httpServer);

httpServer.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'Pulsara API listening');
});

/**
 * Graceful shutdown.
 *
 * On SIGTERM the orchestrator has already stopped routing new traffic to this
 * instance. Closing the listener first, then draining sockets and the database
 * pool, means in-flight requests complete instead of being severed mid-write.
 * The timer is a backstop: if a handler hangs, the process still exits rather
 * than blocking the rollout until the platform's hard kill.
 */
let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ signal }, 'Shutdown signal received; draining connections');

  const forceExit = setTimeout(() => {
    logger.error(
      { graceMs: SHUTDOWN_GRACE_PERIOD_MS },
      'Grace period elapsed with connections still open; forcing exit',
    );
    process.exit(1);
  }, SHUTDOWN_GRACE_PERIOD_MS);
  forceExit.unref();

  try {
    await shutdownRealtimeServer(io);
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => (error ? reject(error) : resolve()));
    });
    await prisma.$disconnect();
    logger.info('Shutdown complete');
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, 'Error during shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

/**
 * An unhandled rejection or uncaught exception leaves the process in an
 * unknown state. Logging and exiting lets the orchestrator replace the
 * instance with a clean one, which is safer than continuing to serve traffic
 * from a corrupted runtime.
 */
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled promise rejection');
  void shutdown('SIGTERM');
});

process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'Uncaught exception');
  void shutdown('SIGTERM');
});
