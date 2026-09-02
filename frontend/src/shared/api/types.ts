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

export type Service = {
  id: string;
  name: string;
  description: string | null;
  status: ServiceState;
  /** Percentage of successful checks over the reporting window. */
  uptime: number;
  /** Most recent observed response time, in milliseconds. */
  responseTime: number;
  updatedAt: string;
};

export type Stage = {
  id: string;
  name: string;
  status: DeploymentStatus;
  /** Seconds, or null while the stage is still running. */
  duration: number | null;
  logs: string | null;
  deploymentId: string;
  createdAt: string;
  updatedAt: string;
};

export type Deployment = {
  id: string;
  repo: string;
  branch: string;
  status: DeploymentStatus;
  /** Seconds, or null while the run is still in flight. */
  duration: number | null;
  userId: string;
  createdAt: string;
  updatedAt: string;
  stages: Stage[];
};

export type Incident = {
  id: string;
  title: string;
  description: string | null;
  severity: Severity;
  status: IncidentStatus;
  service: Pick<Service, 'id' | 'name' | 'status'> | null;
  assignee: Pick<AuthUser, 'id' | 'name' | 'email' | 'avatarUrl'> | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** A single point on the live telemetry stream. */
export type MetricSample = {
  cpu: number;
  memory: number;
  disk: number;
  network: number;
  timestamp: string;
};
