import * as React from 'react';
import { useAuthStore } from '../../shared/store/authStore';
import { Card, CardContent, CardHeader, CardTitle } from '../../shared/components/Card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../shared/components/Table';
import { Badge } from '../../shared/components/Badge';
import { Loader2, AlertCircle, AlertTriangle, Info, CheckCircle2 } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
export default function Alerts() {
  const [incidents, setIncidents] = React.useState<any[]>([]);
  const [isLoading, setIsLoading] = React.useState(true);
  const { accessToken } = useAuthStore();
  React.useEffect(() => {
    const fetchIncidents = async () => {
      try {
        const res = await fetch(`${import.meta.env.VITE_API_URL || 'http://localhost:4000'}/api/incidents`, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        });
        const data = await res.json();
        if (data.success) setIncidents(data.data);
      } catch (err) {
        console.error('Failed to fetch incidents', err);
      } finally {
        setIsLoading(false);
      }
    };
    if (accessToken) fetchIncidents();
  }, [accessToken]);
  const getSeverityIcon = (severity: string) => {
    switch (severity) {
      case 'CRITICAL': return <AlertCircle className="w-5 h-5 text-danger" />;
      case 'HIGH': return <AlertTriangle className="w-5 h-5 text-warning" />;
      case 'MEDIUM': return <AlertTriangle className="w-5 h-5 text-accent" />;
      default: return <Info className="w-5 h-5 text-muted" />;
    }
  };
  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight text-white">Active Incidents & Alerts</h1>
      </div>
      <Card className="w-full border-border/50 bg-surface/30 backdrop-blur-xl">
        <CardHeader>
          <CardTitle>Incident Log</CardTitle>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          {isLoading ? (
            <div className="p-8 flex justify-center text-accent">
              <Loader2 className="w-8 h-8 animate-spin" />
            </div>
          ) : incidents.length === 0 ? (
            <div className="p-8 text-center text-muted">No active incidents found. Everything looks healthy!</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[50px]"></TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead>Service</TableHead>
                  <TableHead>Severity</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="text-right">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {incidents.map((inc) => (
                  <TableRow key={inc.id} className="cursor-pointer hover:bg-surface/50 transition-colors">
                    <TableCell>
                      {getSeverityIcon(inc.severity)}
                    </TableCell>
                    <TableCell className="font-medium text-white max-w-sm truncate" title={inc.title}>
                      {inc.title}
                      <p className="text-xs text-muted font-normal mt-0.5 truncate" title={inc.description}>{inc.description}</p>
                    </TableCell>
                    <TableCell className="text-muted">
                      {inc.service?.name || '--'}
                    </TableCell>
                    <TableCell>
                      <Badge variant={inc.severity === 'CRITICAL' ? 'danger' : inc.severity === 'HIGH' ? 'warning' : 'outline'} className="text-[10px] uppercase">
                        {inc.severity}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted text-xs">
                      {formatDistanceToNow(new Date(inc.createdAt), { addSuffix: true })}
                    </TableCell>
                    <TableCell className="text-right">
                      <Badge variant={inc.status === 'RESOLVED' ? 'success' : inc.status === 'INVESTIGATING' ? 'warning' : 'accent'}>
                        {inc.status === 'RESOLVED' && <CheckCircle2 className="w-3 h-3 mr-1" />}
                        {inc.status}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}