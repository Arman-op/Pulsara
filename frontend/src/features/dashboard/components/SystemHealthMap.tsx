import * as React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '../../../shared/components/Card';
import { StatusDot } from '../../../shared/components/StatusDot';
import { Drawer } from '../../../shared/components/Drawer';
import { useAuthStore } from '../../../shared/store/authStore';

const FALLBACK_SERVICES = [
  { id: '1', name: 'API Gateway', status: 'ONLINE', uptime: 99.99, responseTime: 45 },
  { id: '2', name: 'Auth Service', status: 'ONLINE', uptime: 100, responseTime: 12 },
  { id: '3', name: 'Payment Processor', status: 'ONLINE', uptime: 99.95, responseTime: 150 },
  { id: '4', name: 'Background Workers', status: 'DEGRADED', uptime: 98.2, responseTime: 450 },
  { id: '5', name: 'Primary DB', status: 'ONLINE', uptime: 99.99, responseTime: 5 },
  { id: '6', name: 'Redis Cache', status: 'ONLINE', uptime: 100, responseTime: 1 },
];

export function SystemHealthMap() {
  const [services, setServices] = React.useState<any[]>([]);
  const [selectedService, setSelectedService] = React.useState<string | null>(null);
  const { accessToken } = useAuthStore();

  React.useEffect(() => {
    const fetchServices = async () => {
      try {
        const res = await fetch(`${import.meta.env.VITE_API_URL || 'http://localhost:4000'}/api/services`, {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        const data = await res.json();
        if (data.success) {
          setServices(data.data);
        }
      } catch (err) {
        console.error('Failed to fetch services', err);
      }
    };
    if (accessToken) fetchServices();
  }, [accessToken]);

  const displayServices = services.length > 0 ? services : FALLBACK_SERVICES;

  const getStatusType = (status: string): 'online' | 'warning' | 'offline' => {
    switch (status) {
      case 'ONLINE': return 'online';
      case 'OFFLINE': return 'offline';
      default: return 'warning';
    }
  };

  const selectedServiceDetails = displayServices.find(s => s.id === selectedService);

  return (
    <Card className="col-span-1 md:col-span-2 lg:col-span-3">
      <CardHeader>
        <CardTitle>System Health Map</CardTitle>
      </CardHeader>
      <CardContent>
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
              <span className="text-xs text-muted mt-1 tabular-nums-metric">{svc.uptime}% • {svc.responseTime}ms</span>
            </button>
          ))}
        </div>
      </CardContent>
      <Drawer isOpen={!!selectedService} onClose={() => setSelectedService(null)} title="Service Details">
        {selectedServiceDetails && (
          <div className="space-y-4 text-sm">
            <h3 className="text-lg font-medium text-white">{selectedServiceDetails.name}</h3>
            <div className="flex items-center gap-2">
              <span className="text-muted">Status:</span>
              <span className="capitalize text-white">{selectedServiceDetails.status.toLowerCase()}</span>
              <StatusDot status={getStatusType(selectedServiceDetails.status)} />
            </div>
            <div className="p-4 rounded-md bg-surface border border-border">
              <h4 className="font-semibold text-white mb-2">Metrics</h4>
              <div className="space-y-2 text-muted">
                <div className="flex justify-between"><span>Uptime</span><span className="text-white">{selectedServiceDetails.uptime}%</span></div>
                <div className="flex justify-between"><span>Response Time</span><span className="text-white">{selectedServiceDetails.responseTime}ms</span></div>
              </div>
            </div>
          </div>
        )}
      </Drawer>
    </Card>
  );
}
