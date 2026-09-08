import { Activity, AlertTriangle, CheckCircle2, Rocket } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { Incident, IncidentSummary, Service, Severity } from '../../shared/api/types';
import { useApi } from '../../shared/api/useApi';
import { Badge } from '../../shared/components/Badge';
import { Card, CardContent, CardHeader, CardTitle } from '../../shared/components/Card';
import { useAuthStore } from '../../shared/store/authStore';
import { InfraChart } from '../infrastructure/components/InfraChart';

/**
 * Operations overview.
 *
 * The dashboard previously rendered the entire Pipelines and Alerts *pages*
 * inside itself, which meant two more `<h1>` elements on the page, duplicate
 * network requests for data already on screen, and no way to give either
 * section a summary treatment appropriate to an overview.
 *
 * It now composes purpose-built summaries from endpoints that aggregate in the
 * database, and links through to the full views.
 */

type DeploymentStats = {
  sampled: number;
  finished: number;
  succeeded: number;
  failed: number;
  successRatePercent: number | null;
  medianDurationSeconds: number | null;
};

const SEVERITY_ORDER: Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

const SEVERITY_TONE: Record<Severity, string> = {
  CRITICAL: 'text-danger',
  HIGH: 'text-warning',
  MEDIUM: 'text-accent',
  LOW: 'text-muted',
};

/** Poll interval for the summary tiles, which are cheap aggregate queries. */
const SUMMARY_POLL_MS = 30_000;

function StatTile({
  label,
  value,
  hint,
  icon: Icon,
  tone = 'text-white',
}: {
  label: string;
  value: string;
  hint?: string;
  icon: React.ComponentType<{ className?: string }>;
  tone?: string;
}) {
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
          <p className={`text-2xl font-semibold mt-1.5 tabular-nums-metric ${tone}`}>{value}</p>
          {hint && <p className="text-xs text-muted mt-1">{hint}</p>}
        </div>
        <Icon className="w-5 h-5 text-muted shrink-0" />
      </div>
    </Card>
  );
}

export default function Dashboard() {
  const user = useAuthStore((store) => store.user);

  const services = useApi<Service[]>('/services', { pollMs: SUMMARY_POLL_MS });
  const incidents = useApi<IncidentSummary>('/incidents/summary', { pollMs: SUMMARY_POLL_MS });
  const deployments = useApi<DeploymentStats>('/deployments/stats', { pollMs: SUMMARY_POLL_MS });
  const openIncidents = useApi<Incident[]>('/incidents?isOpen=true&limit=5', {
    pollMs: SUMMARY_POLL_MS,
  });

  const serviceList = services.data ?? [];
  const healthy = serviceList.filter((service) => service.status === 'ONLINE').length;
  const measured = serviceList.filter((service) => service.sampleCount > 0);

  /**
   * Averaged across services that actually have observations. Including
   * unmeasured services as 100% would inflate the figure with data that does
   * not exist; showing "—" until something has been measured is the honest
   * alternative.
   */
  const fleetUptime =
    measured.length > 0
      ? measured.reduce((total, service) => total + (service.uptimePercent ?? 0), 0) /
        measured.length
      : null;

  return (
    <div className="space-y-8 animate-in fade-in duration-500 max-w-7xl mx-auto">
      <div className="flex flex-col gap-1">
        <h1 className="text-3xl font-extrabold tracking-tight text-white">
          Welcome back, {user?.name ?? 'operator'}
        </h1>
        <p className="text-muted text-sm">Everything below is measured, not estimated.</p>
      </div>

      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Services online"
          value={serviceList.length === 0 ? '—' : `${healthy}/${serviceList.length}`}
          hint={serviceList.length === 0 ? 'no services registered' : 'currently reachable'}
          icon={CheckCircle2}
          tone={
            serviceList.length > 0 && healthy < serviceList.length ? 'text-warning' : 'text-success'
          }
        />
        <StatTile
          label="Fleet uptime"
          value={fleetUptime === null ? '—' : `${fleetUptime.toFixed(2)}%`}
          hint={
            measured.length === 0
              ? 'not yet measured'
              : `across ${measured.length} measured service${measured.length === 1 ? '' : 's'}`
          }
          icon={Activity}
        />
        <StatTile
          label="Open incidents"
          value={incidents.data ? String(incidents.data.open) : '—'}
          hint={incidents.data ? `${incidents.data.resolved} resolved to date` : undefined}
          icon={AlertTriangle}
          tone={incidents.data && incidents.data.open > 0 ? 'text-danger' : 'text-success'}
        />
        <StatTile
          label="Deploy success rate"
          value={
            deployments.data?.successRatePercent === null ||
            deployments.data?.successRatePercent === undefined
              ? '—'
              : `${deployments.data.successRatePercent}%`
          }
          hint={
            deployments.data && deployments.data.finished > 0
              ? `last ${deployments.data.finished} finished runs`
              : 'no runs recorded'
          }
          icon={Rocket}
        />
      </div>

      {/* The service catalogue lives on Infrastructure rather than being
          duplicated here; this is the half-hour glance. */}
      <div className="grid gap-6 grid-cols-1 lg:grid-cols-6">
        <InfraChart />
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle>Open incidents</CardTitle>
          <Link to="/alerts" className="text-xs text-accent hover:underline">
            View all
          </Link>
        </CardHeader>
        <CardContent>
          {openIncidents.isLoading ? (
            <p className="py-6 text-center text-sm text-muted">Loading…</p>
          ) : openIncidents.error ? (
            <p className="py-6 text-center text-sm text-danger" role="alert">
              {openIncidents.error}
            </p>
          ) : (openIncidents.data?.length ?? 0) === 0 ? (
            <p className="py-6 text-center text-sm text-muted">
              No open incidents. The alerting engine opens one automatically when a monitored
              service stops responding.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {(openIncidents.data ?? []).map((incident) => (
                <li key={incident.id} className="py-3 flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-sm text-white truncate">{incident.title}</p>
                    <p className="text-xs text-muted mt-0.5">
                      {incident.service?.name ?? 'no service'} ·{' '}
                      {incident.source === 'AUTOMATED' ? 'auto-detected' : 'reported'} ·{' '}
                      {new Date(incident.createdAt).toLocaleString()}
                    </p>
                  </div>
                  <Badge
                    variant={
                      incident.severity === 'CRITICAL'
                        ? 'danger'
                        : incident.severity === 'HIGH'
                          ? 'warning'
                          : 'outline'
                    }
                    className="shrink-0 text-[10px]"
                  >
                    {incident.severity}
                  </Badge>
                </li>
              ))}
            </ul>
          )}

          {incidents.data && incidents.data.open > 0 && (
            <div className="flex flex-wrap gap-4 pt-4 mt-2 border-t border-border text-xs">
              {SEVERITY_ORDER.map((severity) => {
                const count = incidents.data?.openBySeverity[severity] ?? 0;
                if (count === 0) return null;
                return (
                  <span key={severity} className={SEVERITY_TONE[severity]}>
                    {count} {severity.toLowerCase()}
                  </span>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
