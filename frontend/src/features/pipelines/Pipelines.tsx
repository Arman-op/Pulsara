import * as React from 'react';
import { useAuthStore } from '../../shared/store/authStore';
import { Card, CardContent, CardHeader, CardTitle } from '../../shared/components/Card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../shared/components/Table';
import { Badge } from '../../shared/components/Badge';
import { Loader2 } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
export default function Pipelines() {
  const [deployments, setDeployments] = React.useState<any[]>([]);
  const [isLoading, setIsLoading] = React.useState(true);
  const { accessToken } = useAuthStore();
  React.useEffect(() => {
    const fetchDeployments = async () => {
      try {
        const res = await fetch(`${import.meta.env.VITE_API_URL || 'http://localhost:4000'}/api/deployments`, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        });
        const data = await res.json();
        if (data.success) setDeployments(data.data);
      } catch (err) {
        console.error('Failed to fetch deployments', err);
      } finally {
        setIsLoading(false);
      }
    };
    if (accessToken) fetchDeployments();
  }, [accessToken]);
  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight text-white">CI/CD Pipelines</h1>
      </div>
      <Card className="w-full border-border/50 bg-surface/30 backdrop-blur-xl">
        <CardHeader>
          <CardTitle>Deployment History</CardTitle>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          {isLoading ? (
            <div className="p-8 flex justify-center text-accent">
              <Loader2 className="w-8 h-8 animate-spin" />
            </div>
          ) : deployments.length === 0 ? (
            <div className="p-8 text-center text-muted">No deployments found.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Repository</TableHead>
                  <TableHead>Branch</TableHead>
                  <TableHead>Triggered</TableHead>
                  <TableHead>Stages</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead className="text-right">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {deployments.map((d) => (
                  <TableRow key={d.id} className="cursor-pointer hover:bg-surface/50 transition-colors">
                    <TableCell className="font-medium text-white">{d.repo}</TableCell>
                    <TableCell className="text-muted">
                      <code className="px-1.5 py-0.5 rounded-md bg-surface border border-border">{d.branch}</code>
                    </TableCell>
                    <TableCell className="text-muted text-xs">
                      {formatDistanceToNow(new Date(d.createdAt), { addSuffix: true })}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {d.stages.map((stg: any, i: number) => (
                          <Badge 
                            key={i} 
                            variant={stg.status === 'RUNNING' ? 'accent' : stg.status === 'FAILED' ? 'danger' : stg.status === 'SUCCESS' ? 'success' : 'outline'} 
                            className="text-[10px] uppercase"
                          >
                            {stg.status === 'RUNNING' && <Loader2 className="w-2.5 h-2.5 mr-1 animate-spin" />}
                            {stg.name}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted tabular-nums-metric">
                      {d.duration ? `${Math.floor(d.duration / 60)}m ${d.duration % 60}s` : '--'}
                    </TableCell>
                    <TableCell className="text-right">
                      <Badge variant={d.status === 'SUCCESS' ? 'success' : d.status === 'FAILED' ? 'danger' : 'accent'}>
                        {d.status}
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