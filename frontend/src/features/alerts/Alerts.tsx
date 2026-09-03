import { formatDistanceToNow } from 'date-fns';
import { AlertCircle, AlertTriangle, CheckCircle2, Info, Loader2 } from 'lucide-react';
import * as React from 'react';
import { ApiError, apiRequest } from '../../shared/api/client';
import type { Incident, IncidentStatus, Severity } from '../../shared/api/types';
import { useApi } from '../../shared/api/useApi';
import { Badge } from '../../shared/components/Badge';
import { Card, CardContent, CardHeader, CardTitle } from '../../shared/components/Card';
import { Drawer } from '../../shared/components/Drawer';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../shared/components/Table';
import { useAuthStore } from '../../shared/store/authStore';
import { useToastStore } from '../../shared/store/toastStore';

/**
 * Incident feed.
 *
 * Incidents were two rows written by the seed script describing services that
 * did not exist. Every entry here is either opened by the alerting engine from
 * real probe results, or raised by a person — and the two are labelled
 * differently, because "a machine noticed this" and "a colleague filed this"
 * mean different things when you are deciding what to do.
 */

const POLL_MS = 20_000;

const STATUS_FLOW: IncidentStatus[] = ['INVESTIGATING', 'IDENTIFIED', 'MONITORING', 'RESOLVED'];

function SeverityIcon({ severity }: { severity: Severity }) {
  switch (severity) {
    case 'CRITICAL':
      return <AlertCircle className="w-5 h-5 text-danger" aria-label="Critical" />;
    case 'HIGH':
      return <AlertTriangle className="w-5 h-5 text-warning" aria-label="High" />;
    case 'MEDIUM':
      return <AlertTriangle className="w-5 h-5 text-accent" aria-label="Medium" />;
    default:
      return <Info className="w-5 h-5 text-muted" aria-label="Low" />;
  }
}

function severityVariant(severity: Severity) {
  if (severity === 'CRITICAL') return 'danger' as const;
  if (severity === 'HIGH') return 'warning' as const;
  return 'outline' as const;
}

/** Only MEMBER and above may change an incident; the server enforces it too. */
function canMutate(role: string | undefined): boolean {
  return role === 'MEMBER' || role === 'ADMIN';
}

function IncidentDetail({ incidentId, onChanged }: { incidentId: string; onChanged: () => void }) {
  const role = useAuthStore((store) => store.user?.role);
  const addToast = useToastStore((store) => store.addToast);
  const { data, isLoading, error, refresh } = useApi<Incident>(`/incidents/${incidentId}`);
  const [isSaving, setIsSaving] = React.useState(false);
  const [comment, setComment] = React.useState('');

  const mutate = async (body: Record<string, unknown>, success: string) => {
    setIsSaving(true);
    try {
      await apiRequest(`/incidents/${incidentId}`, { method: 'PATCH', body });
      addToast({ type: 'success', title: success });
      refresh();
      onChanged();
    } catch (caught) {
      addToast({
        type: 'error',
        title: 'Update rejected',
        message: caught instanceof ApiError ? caught.message : 'Something went wrong',
      });
    } finally {
      setIsSaving(false);
    }
  };

  const addComment = async (event: React.FormEvent) => {
    event.preventDefault();
    if (comment.trim().length === 0) return;
    setIsSaving(true);
    try {
      await apiRequest(`/incidents/${incidentId}/comments`, {
        method: 'POST',
        body: { message: comment.trim() },
      });
      setComment('');
      refresh();
    } catch (caught) {
      addToast({
        type: 'error',
        title: 'Could not add note',
        message: caught instanceof ApiError ? caught.message : 'Something went wrong',
      });
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) return <p className="text-sm text-muted">Loading incident…</p>;
  if (error)
    return (
      <p className="text-sm text-danger" role="alert">
        {error}
      </p>
    );
  if (!data) return null;

  return (
    <div className="space-y-5 text-sm">
      <div>
        <div className="flex items-start gap-2">
          <SeverityIcon severity={data.severity} />
          <h3 className="text-base font-medium text-white">{data.title}</h3>
        </div>
        {data.description && <p className="text-xs text-muted mt-2">{data.description}</p>}
      </div>

      <dl className="grid grid-cols-2 gap-3 p-3 rounded-md bg-surface border border-border text-xs">
        <div>
          <dt className="text-muted">Service</dt>
          <dd className="text-white mt-0.5">{data.service?.name ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-muted">Source</dt>
          <dd className="text-white mt-0.5">
            {data.source === 'AUTOMATED' ? 'Alerting engine' : 'Reported by a person'}
          </dd>
        </div>
        <div>
          <dt className="text-muted">Opened</dt>
          <dd className="text-white mt-0.5">{new Date(data.createdAt).toLocaleString()}</dd>
        </div>
        <div>
          <dt className="text-muted">Resolved</dt>
          <dd className="text-white mt-0.5">
            {data.resolvedAt ? new Date(data.resolvedAt).toLocaleString() : '—'}
          </dd>
        </div>
      </dl>

      {canMutate(role) && (
        <div className="flex flex-wrap gap-2">
          {STATUS_FLOW.filter((status) => status !== data.status).map((status) => (
            <button
              key={status}
              disabled={isSaving}
              onClick={() => void mutate({ status }, `Marked ${status.toLowerCase()}`)}
              className="text-xs px-2.5 py-1.5 rounded-md border border-border text-muted hover:text-white hover:bg-surface transition-colors disabled:opacity-50"
            >
              {status === 'RESOLVED' ? 'Resolve' : `Mark ${status.toLowerCase()}`}
            </button>
          ))}
        </div>
      )}

      <div>
        <h4 className="font-semibold text-white mb-2">Timeline</h4>
        {/* The row shows only current state; the timeline is what makes a
            postmortem possible. */}
        <ol className="space-y-2 border-l border-border pl-4">
          {(data.events ?? []).map((event) => (
            <li key={event.id} className="relative">
              <span className="absolute -left-[21px] top-1.5 w-2 h-2 rounded-full bg-accent" />
              <p className="text-xs text-white">{event.message}</p>
              <p className="text-[11px] text-muted mt-0.5">
                {event.kind.toLowerCase().replace(/_/g, ' ')} ·{' '}
                {new Date(event.createdAt).toLocaleString()}
              </p>
            </li>
          ))}
        </ol>
      </div>

      {canMutate(role) && (
        <form onSubmit={addComment} className="space-y-2">
          <label className="text-xs font-medium text-white" htmlFor="incident-note">
            Add a note
          </label>
          <textarea
            id="incident-note"
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            rows={3}
            maxLength={1000}
            className="w-full rounded-md bg-surface border border-border p-2 text-sm text-white focus:ring-2 focus:ring-accent outline-none"
            placeholder="What did you find?"
          />
          <button
            type="submit"
            disabled={isSaving || comment.trim().length === 0}
            className="text-xs px-3 py-1.5 rounded-md bg-accent/10 text-accent hover:bg-accent/20 transition-colors disabled:opacity-50"
          >
            Add note
          </button>
        </form>
      )}
    </div>
  );
}

export default function Alerts() {
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [showResolved, setShowResolved] = React.useState(false);

  const query = showResolved ? '/incidents' : '/incidents?isOpen=true';
  const { data, isLoading, error, refresh } = useApi<Incident[]>(query, { pollMs: POLL_MS });

  const incidents = data ?? [];

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-2xl font-bold tracking-tight text-white">Incidents</h1>
        <label className="flex items-center gap-2 text-xs text-muted cursor-pointer">
          <input
            type="checkbox"
            checked={showResolved}
            onChange={(event) => setShowResolved(event.target.checked)}
            className="w-4 h-4 rounded border-border bg-surface text-accent focus:ring-accent"
          />
          Include resolved
        </label>
      </div>

      <Card className="w-full border-border/50 bg-surface/30 backdrop-blur-xl">
        <CardHeader>
          <CardTitle>{showResolved ? 'All incidents' : 'Open incidents'}</CardTitle>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          {isLoading ? (
            <div className="p-8 flex justify-center text-accent">
              <Loader2 className="w-8 h-8 animate-spin" />
            </div>
          ) : error ? (
            <div className="p-8 text-center text-danger" role="alert">
              {error}
            </div>
          ) : incidents.length === 0 ? (
            <div className="p-10 text-center text-muted space-y-1">
              <CheckCircle2 className="w-6 h-6 mx-auto text-success" />
              <p className="text-white font-medium">
                {showResolved ? 'No incidents recorded' : 'No open incidents'}
              </p>
              <p className="text-xs">
                The alerting engine opens one automatically when a monitored service stops
                responding.
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[50px]" />
                  <TableHead>Title</TableHead>
                  <TableHead>Service</TableHead>
                  <TableHead>Severity</TableHead>
                  <TableHead>Opened</TableHead>
                  <TableHead className="text-right">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {incidents.map((incident) => (
                  <TableRow
                    key={incident.id}
                    onClick={() => setSelectedId(incident.id)}
                    className="cursor-pointer hover:bg-surface/50 transition-colors"
                  >
                    <TableCell>
                      <SeverityIcon severity={incident.severity} />
                    </TableCell>
                    <TableCell className="font-medium text-white max-w-sm">
                      <span className="block truncate" title={incident.title}>
                        {incident.title}
                      </span>
                      {incident.description && (
                        <span
                          className="block text-xs text-muted font-normal mt-0.5 truncate"
                          title={incident.description}
                        >
                          {incident.description}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted">
                      {incident.service?.name ?? '—'}
                      <span className="block text-[10px] uppercase tracking-wide text-muted/70 mt-0.5">
                        {incident.source === 'AUTOMATED' ? 'auto-detected' : 'reported'}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={severityVariant(incident.severity)}
                        className="text-[10px] uppercase"
                      >
                        {incident.severity}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted text-xs">
                      {formatDistanceToNow(new Date(incident.createdAt), { addSuffix: true })}
                    </TableCell>
                    <TableCell className="text-right">
                      <Badge
                        variant={
                          incident.status === 'RESOLVED'
                            ? 'success'
                            : incident.status === 'INVESTIGATING'
                              ? 'warning'
                              : 'accent'
                        }
                      >
                        {incident.status === 'RESOLVED' && (
                          <CheckCircle2 className="w-3 h-3 mr-1" />
                        )}
                        {incident.status}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Drawer
        isOpen={selectedId !== null}
        onClose={() => setSelectedId(null)}
        title="Incident detail"
      >
        {selectedId && <IncidentDetail incidentId={selectedId} onChanged={refresh} />}
      </Drawer>
    </div>
  );
}
