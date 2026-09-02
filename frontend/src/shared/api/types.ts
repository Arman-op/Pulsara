/**
 * The shape of everything the API returns.
 *
 * These mirror the Prisma models and the response envelope defined in
 * `backend/src/lib/http.ts`. Until the two packages share a generated client,
 * this file is the single place the contract is written down on the client
 * side — previously every component declared its state as `any[]`, so a field
 * rename on the server produced `undefined` in the UI rather than a build
 * failure.
 *
 * Dates arrive as ISO-8601 strings because they have been through JSON; they
 * are typed as `string` rather than `Date` so nobody is tempted to call a date
 * method on one.
 */

export type Role = 'ADMIN' | 'MEMBER' | 'VIEWER';
export type ServiceState = 'ONLINE' | 'OFFLINE' | 'DEGRADED' | 'MAINTENANCE';
export type DeploymentStatus = 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'CANCELED';
export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
export type IncidentStatus = 'INVESTIGATING' | 'IDENTIFIED' | 'MONITORING' | 'RESOLVED';

export type PageMeta = {
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
};

export type ApiSuccess<T> = {
  success: true;
  data: T;
  meta?: PageMeta & Record<string, unknown>;
};

export type ApiFailure = {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId?: string;
  };
};

/**
 * Discriminated on `success`, so narrowing on it gives the caller either data
 * or an error and never both.
 */
export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export type AuthUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
  avatarUrl?: string | null;
  lastLoginAt?: string | null;
};

export type ProbeType = 'HTTP' | 'TCP';

/**
 * Health derived from stored probe results.
 *
 * Every field is nullable, and that is the point: null means "not measured",
 * which is a different and more honest answer than zero. A service that has
 * never been checked must not render as 0% uptime, and one that has never
 * responded must not render as 0ms latency.
 */
export type ServiceHealth = {
  uptimePercent: number | null;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  lastLatencyMs: number | null;
  sampleCount: number;
  lastCheckedAt: string | null;
};

export type Service = ServiceHealth & {
  id: string;
  name: string;
  description: string | null;
  status: ServiceState;
  probeType: ProbeType | null;
  probeTarget: string | null;
  probeIntervalSeconds: number;
  isMonitored: boolean;
  updatedAt: string;
};

export type CiProvider = 'GITHUB';

/** One job within a workflow run. */
export type Stage = {
  id: string;
  externalId: string | null;
  name: string;
  status: DeploymentStatus;
  /** Seconds, or null while the job is still running. */
  duration: number | null;
  /** Link to this job on the provider, so a failure is one click from logs. */
  externalUrl: string | null;
  startedAt: string | null;
  completedAt: string | null;
  deploymentId: string;
  createdAt: string;
  updatedAt: string;
};

/** A workflow run mirrored from the CI provider. */
export type Deployment = {
  id: string;
  provider: CiProvider;
  externalId: string;
  externalUrl: string | null;
  repo: string;
  branch: string;
  workflowName: string | null;
  /** What triggered the run: push, pull_request, schedule, workflow_dispatch. */
  event: string | null;
  status: DeploymentStatus;
  /** Seconds, or null while the run is still in flight. */
  duration: number | null;
  commitSha: string | null;
  commitMessage: string | null;
  actorLogin: string | null;
  actorAvatarUrl: string | null;
  startedAt: string | null;
  completedAt: string | null;
  userId: string | null;
  createdAt: string;
  updatedAt: string;
  stages: Stage[];
};

/**
 * Accompanies a deployment list.
 *
 * `connectedRepositories` is what lets the UI tell "no repository is connected"
 * apart from "connected, but nothing has run yet". Both are an empty list, and
 * only one of them is a configuration problem.
 */
export type DeploymentListMeta = PageMeta & {
  connectedRepositories: number;
  pollingConfigured: boolean;
  webhookConfigured: boolean;
};

export type RepoConnection = {
  id: string;
  provider: CiProvider;
  owner: string;
  name: string;
  defaultBranch: string | null;
  isActive: boolean;
  lastSyncedAt: string | null;
  /** Surfaced in the UI so a broken token is visible, not silently empty. */
  lastSyncError: string | null;
  createdAt: string;
  _count?: { deployments: number };
};

/// Whether an incident was raised by the alerting engine or by a person.
export type IncidentSource = 'AUTOMATED' | 'MANUAL';

export type IncidentEventKind =
  | 'OPENED'
  | 'STATUS_CHANGED'
  | 'SEVERITY_CHANGED'
  | 'ASSIGNED'
  | 'COMMENTED'
  | 'RESOLVED'
  | 'REOPENED';

/** One entry in an incident timeline. */
export type IncidentEvent = {
  id: number;
  incidentId: string;
  kind: IncidentEventKind;
  message: string;
  actorId: string | null;
  createdAt: string;
};

export type Incident = {
  id: string;
  title: string;
  description: string | null;
  severity: Severity;
  status: IncidentStatus;
  source: IncidentSource;
  /** True while the incident counts as open; drives ordering and filtering. */
  isOpen: boolean;
  service: Pick<Service, 'id' | 'name' | 'status'> | null;
  assignee: Pick<AuthUser, 'id' | 'name' | 'email' | 'avatarUrl'> | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Present only on the single-incident endpoint. */
  events?: IncidentEvent[];
};

/** Aggregated counts for the dashboard summary. */
export type IncidentSummary = {
  total: number;
  open: number;
  resolved: number;
  openBySeverity: Partial<Record<Severity, number>>;
};

/**
 * A single host telemetry snapshot from the live stream.
 *
 * Fields are nullable because not every counter exists on every platform, and
 * a family that could not be read is omitted rather than reported as zero.
 * Load average, for instance, does not exist on Windows.
 */
export type HostSnapshot = {
  host: string;
  /** Percentage. */
  cpu: number | null;
  memory: number | null;
  disk: number | null;
  /** Bytes per second. */
  networkRx: number | null;
  networkTx: number | null;
  /** 1-minute load average normalised by core count; 1.0 is fully committed. */
  load1m: number | null;
  timestamp: string;
};

/** One bucketed point from the metric series endpoint. */
export type MetricSeriesPoint = {
  timestamp: string;
} & Partial<Record<'cpu' | 'memory' | 'disk' | 'network_rx' | 'network_tx' | 'load_1m', number>>;

export type MetricSeriesMeta = {
  host: string;
  from: string;
  to: string;
  /** Width of each bucket, so the axis can be labelled honestly. */
  bucketSeconds: number;
  types: string[];
  collectorEnabled: boolean;
};

/** Emitted when the probe scheduler moves a service between states. */
export type ServiceStatusChange = {
  serviceId: string;
  name: string;
  previous: ServiceState;
  current: ServiceState;
  latencyMs: number | null;
  error: string | null;
  changedAt: string;
};
