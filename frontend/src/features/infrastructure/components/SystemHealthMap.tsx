import * as React from 'react';
import { env } from '../../../config/env';
import { RealtimeChannel, createAuthenticatedSocket } from '../../../shared/api/socket';
import type { ApiResponse, Service, ServiceStatusChange } from '../../../shared/api/types';
import { Card, CardContent, CardHeader, CardTitle } from '../../../shared/components/Card';
import { Drawer } from '../../../shared/components/Drawer';
import { StatusDot } from '../../../shared/components/StatusDot';
import { useAuthStore } from '../../../shared/store/authStore';

/**
 * Service health map.
 *
 * This component previously rendered a hard-coded array of six services with
 * invented uptime and latency figures whenever the request failed, so an
 * unreachable API was indistinguishable from a healthy fleet. That array is
 * gone, and every figure here now comes from stored probe results.
 *
 * A metric that has not been measured renders as an em dash, never as zero.
 * "0% uptime" and "never checked" mean very different things at three in the
 * morning.
 */

type ServiceMeta = { uptimeWindowHours: number; probesEnabled: boolean };

function formatUptime(percent: number | null): string {
  if (percent === null) return '—';
  // Two decimals: the gap between 99.95% and 99.99% is roughly 17 minutes of
  // monthly downtime, and rounding to whole percent hides it entirely.
  return `${percent.toFixed(2)}%`;
}

function formatLatency(ms: number | null): string {
  return ms === null ? '—' : `${ms}ms`;
}

function statusTone(status: Service['status']): 'online' | 'warning' | 'offline' {
  switch (status) {
    case 'ONLINE':
      return 'online';
    case 'OFFLINE':
      return 'offline';
    default:
      return 'warning';
  }
}

export function SystemHealthMap() {
  const [services, setServices] = React.useState<Service[]>([]);
  const [meta, setMeta] = React.useState<ServiceMeta | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [isLoading, setIsLoading] = React.useState(true);
  const accessToken = useAuthStore((store) => store.accessToken);

  React.useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;

    const load = async () => {
      try {
        const res = await fetch(`${env.VITE_API_URL}/api/services`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        const body = (await res.json()) as ApiResponse<Service[]>;
        if (cancelled) return;

        if (body.success) {
          setServices(body.data);
          setMeta((body.meta as unknown as ServiceMeta) ?? null);
          setLoadError(null);
        } else {
          setLoadError(body.error.message);
        }
      } catch {
        if (!cancelled) setLoadError('The service catalogue could not be reached.');
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [accessToken]);

  /**
   * Status transitions arrive over the socket, so a service going down updates
   * without waiting for a refresh. Only `status` is patched: uptime and latency
   * are windowed aggregates the server owns, and recomputing them in the
   * browser from a single event would produce a number the server disagrees
   * with.
   */
  React.useEffect(() => {
    const socket = createAuthenticatedSocket();
    if (!socket) return;

    socket.on(RealtimeChannel.ServiceStatus, (change: ServiceStatusChange) => {
      setServices((previous) =>
        previous.map((service) =>
          service.id === change.serviceId ? { ...service, status: change.current } : service,
        ),
      );
    });

    return () => {
      socket.close();
    };
  }, [accessToken]);

  const selected = services.find((service) => service.id === selectedId) ?? null;

  return (
    <Card className="col-span-1 md:col-span-2 lg:col-span-3">
      <CardHeader>
        <CardTitle>Service Health</CardTitle>
        {meta && (
          <p className="text-xs text-muted mt-1">
            Uptime over the last {meta.uptimeWindowHours}h
            {!meta.probesEnabled && ' · probing is disabled'}
          </p>
        )}
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="py-8 text-center text-sm text-muted">Loading service catalogue…</p>
        ) : loadError ? (
          <p className="py-8 text-center text-sm text-danger" role="alert">
            {loadError}
          </p>
        ) : services.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted">
            No services are registered yet. Add one to start monitoring it.
          </p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {services.map((service) => (
              <button
                key={service.id}
                onClick={() => setSelectedId(service.id)}
                className="group flex flex-col items-center justify-center p-4 rounded-lg border border-border bg-surface/30 hover:bg-surface transition-colors focus:ring-2 focus:ring-accent outline-none"
              >
                <div className="mb-2">
                  <StatusDot status={statusTone(service.status)} />
                </div>
                <span className="text-sm font-medium text-white text-center">{service.name}</span>
                <span className="text-xs text-muted mt-1 tabular-nums-metric">
                  {formatUptime(service.uptimePercent)} · {formatLatency(service.latencyP50Ms)}
                </span>
                {service.sampleCount === 0 && (
                  <span className="text-[10px] text-muted mt-0.5">not yet measured</span>
                )}
              </button>
            ))}
          </div>
        )}
      </CardContent>

      <Drawer
        isOpen={selected !== null}
        onClose={() => setSelectedId(null)}
        title="Service Details"
      >
        {selected && (
          <div className="space-y-4 text-sm">
            <div>
              <h3 className="text-lg font-medium text-white">{selected.name}</h3>
              {selected.description && (
                <p className="text-xs text-muted mt-1">{selected.description}</p>
              )}
            </div>

            <div className="flex items-center gap-2">
              <span className="text-muted">Status:</span>
              <span className="capitalize text-white">{selected.status.toLowerCase()}</span>
              <StatusDot status={statusTone(selected.status)} />
            </div>

            <div className="p-4 rounded-md bg-surface border border-border">
              <h4 className="font-semibold text-white mb-2">
                Measured over the last {meta?.uptimeWindowHours ?? 24}h
              </h4>
              <dl className="space-y-2 text-muted">
                <div className="flex justify-between">
                  <dt>Uptime</dt>
                  <dd className="text-white tabular-nums-metric">
                    {formatUptime(selected.uptimePercent)}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt>Latency p50</dt>
                  <dd className="text-white tabular-nums-metric">
                    {formatLatency(selected.latencyP50Ms)}
                  </dd>
                </div>
                <div className="flex justify-between">
                  {/* The tail is what users feel; an average would hide it. */}
                  <dt>Latency p95</dt>
                  <dd className="text-white tabular-nums-metric">
                    {formatLatency(selected.latencyP95Ms)}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt>Checks recorded</dt>
                  <dd className="text-white tabular-nums-metric">{selected.sampleCount}</dd>
                </div>
              </dl>
            </div>

            <div className="p-4 rounded-md bg-surface border border-border">
              <h4 className="font-semibold text-white mb-2">Probe</h4>
              <dl className="space-y-2 text-muted">
                <div className="flex justify-between gap-4">
                  <dt>Type</dt>
                  <dd className="text-white">{selected.probeType ?? 'not configured'}</dd>
                </div>
                <div className="flex justify-between gap-4 min-w-0">
                  <dt className="shrink-0">Target</dt>
                  <dd className="text-white truncate" title={selected.probeTarget ?? ''}>
                    {selected.probeTarget ?? '—'}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt>Interval</dt>
                  <dd className="text-white tabular-nums-metric">
                    {selected.probeIntervalSeconds}s
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt>Last checked</dt>
                  <dd className="text-white">
                    {selected.lastCheckedAt
                      ? new Date(selected.lastCheckedAt).toLocaleTimeString()
                      : 'never'}
                  </dd>
                </div>
              </dl>
            </div>
          </div>
        )}
      </Drawer>
    </Card>
  );
}
