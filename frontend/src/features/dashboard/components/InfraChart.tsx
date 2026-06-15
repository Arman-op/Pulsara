import * as React from 'react';
import { io, Socket } from 'socket.io-client';
import { Card, CardContent, CardHeader, CardTitle } from '../../../shared/components/Card';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';

interface MetricPoint {
  cpu: number;
  memory: number;
  network: number;
  disk: number;
  timestamp: string;
  timeLabel: string;
}

export function InfraChart() {
  const [history, setHistory] = React.useState<MetricPoint[]>([]);
  const [currentMetrics, setCurrentMetrics] = React.useState<MetricPoint | null>(null);

  React.useEffect(() => {
    const socketUrl = import.meta.env.VITE_API_URL || 'http://localhost:4000';
    const socket: Socket = io(socketUrl, {
      withCredentials: true,
    });

    socket.on('connect', () => {
      console.log('Connected to metrics websocket stream');
    });

    socket.on('metrics', (data: any) => {
      const time = new Date(data.timestamp);
      const timeLabel = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      
      const point: MetricPoint = {
        ...data,
        timeLabel,
      };

      setCurrentMetrics(point);
      setHistory((prev) => {
        const next = [...prev, point];
        if (next.length > 15) {
          next.shift();
        }
        return next;
      });
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  return (
    <Card className="col-span-1 md:col-span-2 lg:col-span-3">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <div>
          <CardTitle>System Telemetry</CardTitle>
          <p className="text-xs text-muted mt-1">Live infrastructure host metrics (2s ticks)</p>
        </div>
        {currentMetrics && (
          <div className="flex gap-4 text-xs font-mono">
            <span className="text-accent">CPU: {currentMetrics.cpu}%</span>
            <span className="text-[#8884d8]">RAM: {currentMetrics.memory}%</span>
          </div>
        )}
      </CardHeader>
      <CardContent>
        <div className="h-[240px] w-full pt-4">
          {history.length === 0 ? (
            <div className="h-full flex items-center justify-center text-muted text-sm">
              Waiting for live metrics socket stream...
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={history} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorCpu" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--accent)" stopOpacity={0.3}/>
                    <stop offset="95%" stopColor="var(--accent)" stopOpacity={0}/>
                  </linearGradient>
                  <linearGradient id="colorMem" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#8884d8" stopOpacity={0.3}/>
                    <stop offset="95%" stopColor="#8884d8" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                <XAxis dataKey="timeLabel" stroke="var(--muted)" fontSize={10} tickLine={false} />
                <YAxis stroke="var(--muted)" fontSize={10} tickLine={false} domain={[0, 100]} />
                <Tooltip
                  contentStyle={{ backgroundColor: 'var(--surface)', borderColor: 'var(--border)' }}
                  labelStyle={{ color: 'white' }}
                  itemStyle={{ fontSize: 12 }}
                />
                <Area type="monotone" dataKey="cpu" name="CPU (%)" stroke="var(--accent)" fillOpacity={1} fill="url(#colorCpu)" strokeWidth={2} />
                <Area type="monotone" dataKey="memory" name="Memory (%)" stroke="#8884d8" fillOpacity={1} fill="url(#colorMem)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
