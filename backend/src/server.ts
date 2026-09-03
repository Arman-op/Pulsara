import { createServer } from 'node:http';
import { SHUTDOWN_GRACE_PERIOD_MS } from './config/constants';
import {
  env,
  isGitHubPollingConfigured,
  isMetricsScrapeProtected,
  isProduction,
} from './config/env';
import { app } from './app';
import { prisma } from './db/prisma';
import { logger } from './lib/logger';
import { startGitHubSync } from './modules/github/github.service';
import { evaluateHostSample } from './modules/incidents/host-alert-engine';
import { handleServiceStatusChange } from './modules/incidents/incident-engine';
import { startHostCollector } from './modules/telemetry/host-collector';
import { startProbeScheduler } from './modules/telemetry/probe-scheduler';
import { startRetentionJob } from './modules/telemetry/retention';
import {
  RealtimeChannel,
  createPublisher,
  createRealtimeServer,
  shutdownRealtimeServer,
} from './realtime/io';

const httpServer = createServer(app);
const io = createRealtimeServer(httpServer);
const publisher = createPublisher(io);

/**
 * Background workers.
 *
 * Each is independently switchable because they have genuinely different
 * requirements: a test run wants neither, a replica behind a load balancer
 * wants host collection on every instance (each has its own CPU and disk to
 * report), and probing is a fleet-wide concern that should not be multiplied by
 * replica count once this is scaled out.
 */
const hostCollector = env.METRICS_COLLECTION_ENABLED
  ? startHostCollector((snapshot) => {
      publisher.publish(RealtimeChannel.Metrics, snapshot);
      /**
       * Alerting evaluates the sample, not the persisted window. Persistence
       * stores the mean of each window, and a mean is precisely the thing that
       * hides the spike somebody needs to be told about.
       */
      void evaluateHostSample(snapshot);
    })
  : null;

const probeScheduler = env.PROBES_ENABLED
  ? startProbeScheduler((change) => {
      publisher.publish(RealtimeChannel.ServiceStatus, change);
      // The alerting engine reacts to the same transitions the UI sees, so an
      // incident is always backed by a status change a user can point at.
      void handleServiceStatusChange(change);
    })
  : null;

const retentionJob = startRetentionJob();

/**
 * Polling is the reconciling half of the CI integration: webhooks make the data
 * fresh, and this makes it correct by recovering deliveries missed while the
 * service was restarting. It only runs when a token is configured, because
 * without one there is nothing it could read.
 */
const githubSync = env.GITHUB_SYNC_ENABLED && isGitHubPollingConfigured ? startGitHubSync() : null;

if (!hostCollector) {
  logger.warn('Host metric collection is disabled; the telemetry chart will have no data');
}
if (!probeScheduler) {
  logger.warn('Service probing is disabled; service health will not be measured');
}
if (!githubSync) {
  logger.info('GitHub polling is not active; the pipelines view reports it as not connected');
}
if (!env.HOST_ALERTS_ENABLED) {
  logger.warn('Host threshold alerting is disabled; resource pressure will open no incidents');
}
if (env.PROMETHEUS_METRICS_ENABLED && isProduction && !isMetricsScrapeProtected) {
  logger.warn(
    'The /metrics endpoint is unauthenticated; set METRICS_SCRAPE_TOKEN if the port is reachable outside the cluster',
  );
}

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
    // Stop producing before stopping the transport, so nothing tries to publish
    // to a closed socket server on the way out.
    hostCollector?.stop();
    probeScheduler?.stop();
    retentionJob.stop();
    githubSync?.stop();

    await shutdownRealtimeServer(io);
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => {
        /**
         * Socket.IO closes the HTTP server it was attached to, so by the time
         * this runs the listener is normally already down and `close` reports
         * ERR_SERVER_NOT_RUNNING. That is the successful path. Treating it as a
         * failure made every clean shutdown log an error and exit non-zero,
         * which an orchestrator reads as a crash — and which would have hidden
         * a real drain failure among the noise.
         */
        if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
          reject(error);
          return;
        }
        resolve();
      });
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
