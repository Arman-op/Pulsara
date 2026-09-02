import { SystemHealthMap } from '../dashboard/components/SystemHealthMap';
import { InfraChart } from '../dashboard/components/InfraChart';
export default function Infrastructure() {
  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <h1 className="text-2xl font-bold tracking-tight text-white">Infrastructure</h1>
      <div className="grid gap-6 grid-cols-1 lg:grid-cols-6">
        <SystemHealthMap />
        <InfraChart />
      </div>
    </div>
  );
}
