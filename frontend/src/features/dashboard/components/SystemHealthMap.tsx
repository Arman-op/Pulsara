import * as React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '../../../shared/components/Card';
import { StatusDot } from '../../../shared/components/StatusDot';
import { Drawer } from '../../../shared/components/Drawer';
import { useAuthStore } from '../../../shared/store/authStore';
import { env } from '../../../config/env';
import type { ApiResponse, Service } from '../../../shared/api/types';

export function SystemHealthMap() {
  const [services, setServices] = React.useState<Service[]>([]);
  const [selectedService, setSelectedService] = React.useState<string | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [isLoading, setIsLoading] = React.useState(true);
  const { accessToken } = useAuthStore();

  React.useEffect(() => {
    const fetchServices = async () => {
      try {
        const res = await fetch(`${env.VITE_API_URL}/api/services`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        const data = (await res.json()) as ApiResponse<Service[]>;
        if (data.success) {
          setServices(data.data);
        } else {
          setLoadError(data.error.message);
        }
      } catch {
        setLoadError('The service catalogue could not be reached.');
      } finally {
        setIsLoading(false);
      }
    };
    if (accessToken) fetchServices();
  }, [accessToken]);

  /**
   * There is no fallback list. This component previously rendered six
   * hard-coded services whenever the request failed, so an unreachable API
   * looked identical to a perfectly healthy fleet — the single most dangerous
   * failure mode a status board can have.
   */
  const displayServices = services;

  const getStatusType = (status: string): 'online' | 'warning' | 'offline' => {
    switch (status) {
      case 'ONLINE':
        return 'online';
      case 'OFFLINE':
        return 'offline';
      default:
        return 'warning';
    }
  };

  const selectedServiceDetails = displayServices.find((s) => s.id === selectedService);

  return (
    <Card className="col-span-1 md:col-span-2 lg:col-span-3">
      <CardHeader>
        <CardTitle>System Health Map</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="py-8 text-center text-sm text-muted">Loading service catalogue…</p>
        ) : loadError ? (
          <p className="py-8 text-center text-sm text-danger" role="alert">
            {loadError}
          </p>
        ) : displayServices.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted">No services are registered yet.</p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {displayServices.map((svc) => (
              <button
                key={svc.id}
                onClick={() => setSelectedService(svc.id)}
                className="group flex flex-col items-center justify-center p-4 rounded-lg border border-border bg-surface/30 hover:bg-surface transition-colors focus:ring-2 focus:ring-accent outline-none"
              >
                <div className="mb-2">
                  <StatusDot status={getStatusType(svc.status)} />
                </div>
                <span className="text-sm font-medium text-white text-center">{svc.name}</span>
                <span className="text-xs text-muted mt-1 tabular-nums-metric">
                  {svc.uptime}% • {svc.responseTime}ms
                </span>
              </button>
            ))}
          </div>
        )}
      </CardContent>
      <Drawer
        isOpen={!!selectedService}
        onClose={() => setSelectedService(null)}
        title="Service Details"
      >
        {selectedServiceDetails && (
          <div className="space-y-4 text-sm">
            <h3 className="text-lg font-medium text-white">{selectedServiceDetails.name}</h3>
            <div className="flex items-center gap-2">
              <span className="text-muted">Status:</span>
              <span className="capitalize text-white">
                {selectedServiceDetails.status.toLowerCase()}
              </span>
              <StatusDot status={getStatusType(selectedServiceDetails.status)} />
            </div>
            <div className="p-4 rounded-md bg-surface border border-border">
              <h4 className="font-semibold text-white mb-2">Metrics</h4>
              <div className="space-y-2 text-muted">
                <div className="flex justify-between">
                  <span>Uptime</span>
                  <span className="text-white">{selectedServiceDetails.uptime}%</span>
                </div>
                <div className="flex justify-between">
                  <span>Response Time</span>
                  <span className="text-white">{selectedServiceDetails.responseTime}ms</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </Drawer>
    </Card>
  );
}
