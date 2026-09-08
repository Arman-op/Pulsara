import { formatDistanceToNow } from 'date-fns';
import { AlertTriangle, ExternalLink, GitBranch, Loader2 } from 'lucide-react';
import type { Deployment, DeploymentListMeta } from '../../shared/api/types';
import { useApi } from '../../shared/api/useApi';
import { Badge } from '../../shared/components/Badge';
import { Card, CardContent, CardHeader, CardTitle } from '../../shared/components/Card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../shared/components/Table';
/**
 * CI/CD pipeline history.
 *
 * Every row is a real GitHub Actions workflow run. The previous version listed
 * five rows the seed script had invented, with `Math.random()` durations and
 * stages named Build/Test/Deploy that corresponded to nothing that had ever
 * executed.
 *
 * The empty state matters as much as the table: "no repository connected" and
 * "connected but nothing has run" are both an empty list, and only one of them
 * is something the user needs to fix.
 */

function formatDuration(seconds: number | null): string {
  if (seconds === null) return '—';
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`;
}

function statusVariant(status: Deployment['status']) {
  switch (status) {
    case 'SUCCESS':
      return 'success' as const;
    case 'FAILED':
      return 'danger' as const;
    case 'CANCELED':
      return 'outline' as const;
    default:
      return 'accent' as const;
  }
}

const SHORT_SHA_LENGTH = 7;

/** Runs change while you watch them, so the list refreshes on its own. */
const POLL_MS = 20_000;

export default function Pipelines() {
  const { data, meta, isLoading, error } = useApi<Deployment[], DeploymentListMeta>(
    '/deployments',
    { pollMs: POLL_MS },
  );

  const deployments = data ?? [];

  const notConnected = meta !== undefined && meta.connectedRepositories === 0;

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight text-white">CI/CD Pipelines</h1>
      </div>

      <Card className="w-full border-border/50 bg-surface/30 backdrop-blur-xl">
        <CardHeader>
          <CardTitle>Workflow Runs</CardTitle>
          {meta && (
            <p className="text-xs text-muted mt-1">
              {meta.connectedRepositories} repositor
              {meta.connectedRepositories === 1 ? 'y' : 'ies'} connected
              {meta.webhookConfigured ? ' · live webhooks' : ''}
              {meta.pollingConfigured ? ' · polling' : ''}
            </p>
          )}
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
          ) : deployments.length === 0 ? (
            /* The two empty cases are described differently on purpose. */
            <div className="p-10 text-center text-muted space-y-2">
              {notConnected ? (
                <>
                  <AlertTriangle className="w-6 h-6 mx-auto text-warning" />
                  <p className="text-white font-medium">No repository is connected</p>
                  <p className="text-xs max-w-md mx-auto">
                    Connect a GitHub repository to mirror its Actions runs here. Until then there is
                    nothing to show — this view never displays placeholder pipelines.
                  </p>
                </>
              ) : (
                <>
                  <p className="text-white font-medium">No workflow runs yet</p>
                  <p className="text-xs">
                    The repository is connected; runs will appear here as they execute.
                  </p>
                </>
              )}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Repository</TableHead>
                  <TableHead>Branch</TableHead>
                  <TableHead>Commit</TableHead>
                  <TableHead>Triggered</TableHead>
                  <TableHead>Jobs</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead className="text-right">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {deployments.map((deployment) => (
                  <TableRow key={deployment.id} className="hover:bg-surface/50 transition-colors">
                    <TableCell className="font-medium text-white">
                      <div className="flex items-center gap-2">
                        {deployment.repo}
                        {deployment.externalUrl && (
                          <a
                            href={deployment.externalUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-muted hover:text-accent transition-colors"
                            title="Open this run on GitHub"
                          >
                            <ExternalLink className="w-3.5 h-3.5" />
                          </a>
                        )}
                      </div>
                      {deployment.workflowName && (
                        <span className="block text-[11px] text-muted font-normal mt-0.5">
                          {deployment.workflowName}
                          {deployment.event ? ` · ${deployment.event}` : ''}
                        </span>
                      )}
                    </TableCell>

                    <TableCell className="text-muted">
                      <span className="inline-flex items-center gap-1.5">
                        <GitBranch className="w-3 h-3 shrink-0" />
                        <code className="px-1.5 py-0.5 rounded-md bg-surface border border-border text-xs">
                          {deployment.branch}
                        </code>
                      </span>
                    </TableCell>

                    <TableCell className="text-muted max-w-[18rem]">
                      {deployment.commitSha ? (
                        <>
                          <code className="text-xs">
                            {deployment.commitSha.slice(0, SHORT_SHA_LENGTH)}
                          </code>
                          {deployment.commitMessage && (
                            <span
                              className="block text-[11px] truncate"
                              title={deployment.commitMessage}
                            >
                              {deployment.commitMessage}
                            </span>
                          )}
                        </>
                      ) : (
                        '—'
                      )}
                    </TableCell>

                    <TableCell className="text-muted text-xs">
                      {formatDistanceToNow(new Date(deployment.createdAt), { addSuffix: true })}
                      {deployment.actorLogin && (
                        <span className="block text-[11px]">by {deployment.actorLogin}</span>
                      )}
                    </TableCell>

                    <TableCell>
                      {deployment.stages.length === 0 ? (
                        <span className="text-xs text-muted">—</span>
                      ) : (
                        <div className="flex items-center gap-1.5 flex-wrap max-w-[16rem]">
                          {deployment.stages.map((stage) => (
                            <Badge
                              key={stage.id}
                              variant={statusVariant(stage.status)}
                              className="text-[10px]"
                              title={`${stage.name}: ${stage.status}`}
                            >
                              {stage.status === 'RUNNING' && (
                                <Loader2 className="w-2.5 h-2.5 mr-1 animate-spin" />
                              )}
                              {stage.name}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </TableCell>

                    <TableCell className="text-muted tabular-nums-metric">
                      {formatDuration(deployment.duration)}
                    </TableCell>

                    <TableCell className="text-right">
                      <Badge variant={statusVariant(deployment.status)}>{deployment.status}</Badge>
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
