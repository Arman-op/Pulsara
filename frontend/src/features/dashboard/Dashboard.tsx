import { InfraChart } from './components/InfraChart';
import { SystemHealthMap } from './components/SystemHealthMap';
import Pipelines from '../pipelines/Pipelines';
import Alerts from '../alerts/Alerts';
import { useAuthStore } from '../../shared/store/authStore';

export default function Dashboard() {
  const { user } = useAuthStore();

  return (
    <div className="space-y-8 animate-in fade-in duration-500 max-w-7xl mx-auto">
      <div className="flex flex-col gap-1">
        <h1 className="text-3xl font-extrabold tracking-tight text-white">
          Welcome back, {user?.name || 'DevOps Operator'}
        </h1>
        <p className="text-muted text-sm">Here is what's happening on your nodes right now.</p>
      </div>

      <div className="grid gap-6 grid-cols-1 lg:grid-cols-6">
        <InfraChart />
        <SystemHealthMap />
      </div>

      <div className="grid gap-6 grid-cols-1 xl:grid-cols-2">
        <div className="border border-border/30 rounded-xl p-1 bg-surface/10">
          <Pipelines />
        </div>
        <div className="border border-border/30 rounded-xl p-1 bg-surface/10">
          <Alerts />
        </div>
      </div>
    </div>
  );
}
