# Pulsara

Real-time infrastructure intelligence for the people who get paged.

Pulsara consolidates host telemetry, service reachability, CI/CD deployments and
incident state into one console. It is built on a single rule: **the UI never
shows a value the system did not actually observe.** An unreachable API looks
different from a healthy fleet, and a service with no measurements says so.

For the design rationale behind every decision below, see
[ARCHITECTURE.md](./ARCHITECTURE.md).

---

## Stack

| Layer | Technology |
| :--- | :--- |
| Client | React 19, Vite 6, TypeScript, Tailwind CSS, Zustand, Recharts |
| API | Node 22, Express 5, TypeScript, Socket.IO |
| Data | PostgreSQL 16 via Prisma (versioned migrations) |
| Auth | Argon2id passwords + optional Google sign-in via Firebase; rotating refresh tokens |
| Tooling | ESLint (type-aware), Prettier, Zod-validated environment |

---

## Prerequisites

- **Node.js 22+**
- **Docker** (for PostgreSQL, and for running the stack in containers), or an
  existing PostgreSQL 14+ instance

---

## Quick start

### 1. Start PostgreSQL

```bash
docker compose up -d
```

This brings up only the database, which is what you need while running the API
and the client from source. Port 5433 is used deliberately, so it does not clash
with a native PostgreSQL on 5432.

### 2. Configure and start the API

```bash
cd backend
npm install
cp .env.example .env
```

Now edit `.env`. Two values have no safe default and the server **will refuse to
start** without them:

```bash
# Generate a different value for each:
openssl rand -base64 48   # -> JWT_ACCESS_SECRET
openssl rand -base64 48   # -> JWT_REFRESH_SECRET
```

Also set `SEED_ADMIN_PASSWORD` to something at least 12 characters long — this
becomes your first login.

Then create the schema, bootstrap the database and run:

```bash
npm run db:deploy      # apply migrations
npm run db:seed        # first admin + service catalogue with live probe targets
npm run dev            # http://localhost:4000
```

The seed registers three services with **real, reachable probe targets**: this
API, the PostgreSQL instance named by your `DATABASE_URL`, and the web client
origin. Within a minute the dashboard reports measured uptime and latency for
each. If the web client is not running yet it will correctly show as offline;
start it and the probe promotes it back to online on its own.

Check it is alive:

```bash
curl http://localhost:4000/api/health/ready
```

### 3. Configure and start the client

```bash
cd frontend
npm install
cp .env.example .env    # VITE_API_URL=http://localhost:4000 is enough to start
npm run dev             # http://localhost:5174
```

Sign in with the `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` you configured.

> There are no demo credentials. The previous build accepted **any** email
> address paired with the password `password` and signed you in as an
> administrator; that bypass has been removed.

---

## Google sign-in (optional)

Google sign-in is off unless configured, and the button is not rendered when it
is off. To enable it, create a Firebase project and supply **all** of the
following — a partial configuration is rejected at startup rather than silently
disabling the feature.

In `backend/.env`, from *Project settings → Service accounts*:

```
FIREBASE_PROJECT_ID=
FIREBASE_CLIENT_EMAIL=
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----\n"
```

In `frontend/.env`, from *Project settings → General → Your apps*:

```
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_AUTH_DOMAIN=
VITE_FIREBASE_PROJECT_ID=
VITE_FIREBASE_APP_ID=
VITE_FIREBASE_MESSAGING_SENDER_ID=
VITE_FIREBASE_STORAGE_BUCKET=
```

The first account to exist in a deployment becomes `ADMIN`. Everyone after that
starts as `VIEWER` and must be promoted deliberately by an administrator through
`PATCH /api/users/:id`.

An administrator cannot demote or deactivate themselves, and the last active
administrator cannot be removed — both are ways to end up locked out of your own
deployment with no path back.

---

## GitHub Actions (optional)

Without this configured, the Pipelines view says so plainly. It never shows
placeholder pipelines.

**1. Choose a credential.** Exactly one — configuring both is rejected at
startup, since which one is talking to GitHub would otherwise depend on code
order rather than on configuration.

*A GitHub App* — the right answer for anything deployed, because a token is
somebody's personal credential and stops working the day they leave. Create one
at *Settings → Developer settings → GitHub Apps* with repository permissions
**Actions: Read-only** and **Metadata: Read-only**, subscribe it to the
**Workflow run** and **Workflow job** events, install it on the account that
owns the repository, then:

```bash
# Convert the .pem GitHub gave you into a single-line value
node -e "console.log(JSON.stringify(require('fs').readFileSync(process.argv[1],'utf8')))" app.pem
```

```
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----\n"
```

*A fine-grained PAT* — fine for a laptop. **Actions: Read-only** and
**Metadata: Read-only** on the repositories you want to mirror:

```
GITHUB_TOKEN=github_pat_...
```

The full comparison is in
[ARCHITECTURE.md](./ARCHITECTURE.md#9-cicd-mirroring-github-actions).

**2. Name the repository to mirror.** It is connected and backfilled at startup,
so the Pipelines page has real content on first boot:

```
GITHUB_MONITORED_REPO=your-org/your-repo
```

Further repositories can be connected at runtime, as an `ADMIN` user:

```bash
curl -X POST http://localhost:4000/api/integrations/github/connections \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"owner":"your-org","name":"your-repo"}'
```

Either way the repository is verified against the API before it is stored, so a
typo fails immediately instead of becoming a connection that silently never
syncs, and recent runs are backfilled straight away.

**3. Add a webhook (optional, for live updates).** In the repository's
*Settings → Webhooks*:

- Payload URL: `https://your-host/api/integrations/github/webhook`
  (a GitHub App carries this on the App itself rather than per repository)
- Content type: `application/json`
- Secret: generate with `openssl rand -base64 32` and set the same value as
  `GITHUB_WEBHOOK_SECRET` in `backend/.env`
- Events: **Workflow runs** and **Workflow jobs**

Deliveries without a valid HMAC-SHA256 signature are rejected. Polling still
reconciles anything a missed delivery would have lost, so webhooks are an
optimisation rather than a requirement.

---

## Running it in containers

The whole stack, built from source and served the way it would be deployed:

```bash
cp backend/.env.example backend/.env      # then fill in the secrets
docker compose --profile app up --build
```

The client is on <http://localhost:5174> and the API on
<http://localhost:4000>, the same ports the dev servers use, so `CORS_ORIGINS`
does not have to change between the two ways of running it.

Both images are multi-stage: the toolchain and the source stay in the build
stage, the API runs as the unprivileged `node` user, the client is served by
unprivileged nginx on 8080, and both declare a `HEALTHCHECK`. The API's checks
liveness rather than readiness, because a database blip must not make an
orchestrator restart every replica during a failover.

The client's API origin is a **build argument**, not a runtime variable: Vite
inlines `VITE_*` values into the bundle, so an image is built for one
deployment and cannot be repointed at another by changing an environment
variable.

---

## Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request:

| Job | What it does |
| :--- | :--- |
| API | Prettier, ESLint, `tsc`, unit tests, integration tests against a real PostgreSQL service container, build |
| Web | Prettier, ESLint, `tsc`, Vitest, production build |
| Images | Builds both images; pushes them to GHCR only from `main` |

Images are built on every run so a broken Dockerfile fails the pull request that
caused it, but published only from the default branch — a fork's pull request
must never be able to publish a tag a deployment might pull. Set the repository
variable `VITE_API_URL` to the origin the published client should talk to.

---

## Monitoring

Pulsara exposes itself the way it expects other systems to: `GET /metrics`
serves Prometheus text exposition, at the root and outside the JSON envelope,
because that is the path and format every scraper already expects.

```bash
curl -s localhost:4000/metrics | grep '^pulsara_'
```

```
pulsara_host_cpu_usage_ratio{host="Arman"} 0.2448
pulsara_host_memory_usage_ratio{host="Arman"} 0.9199
pulsara_host_disk_usage_ratio{host="Arman"} 0.7792
pulsara_host_sample_age_seconds{host="Arman"} 3.639
pulsara_service_up{service="Pulsara API",state="ONLINE"} 1
pulsara_service_uptime_ratio{service="Pulsara Web"} 0.10826
pulsara_service_latency_seconds{service="Pulsara API",quantile="0.95"} 0.013
pulsara_incidents_open{severity="CRITICAL",source="AUTOMATED"} 1
pulsara_deployments{status="FAILED"} 1
```

Values are in base units — seconds, bytes, and ratios in 0..1 rather than
percentages — and the standard `process_*` and `nodejs_*` families are exported
under their conventional names, so off-the-shelf Node dashboards work unchanged.
A metric that has not been measured is an **absent series**, never a zero.

Scrape it with:

```yaml
scrape_configs:
  - job_name: pulsara
    static_configs:
      - targets: ['pulsara-api:4000']
```

Set `METRICS_SCRAPE_TOKEN` if the port is reachable from outside the cluster;
the scraper then needs `authorization: Bearer <token>`. The response names every
monitored service, reports host saturation and counts open incidents.

### Where incidents come from

| Source | Opens when | Resolves when |
| :--- | :--- | :--- |
| Service probing | A monitored service fails its checks | It answers again |
| Host resources | CPU, memory or disk stays over its threshold | Usage stays under it |
| GitHub Actions | The default branch's workflow is failing | It passes again |
| A person | Somebody opens one in the UI | Somebody resolves it |

The first three are `AUTOMATED` and deduplicated per condition, so a flapping
service produces one incident rather than one per probe. The fourth is `MANUAL`,
carries no dedupe key — two people tracking two problems on one service is
legitimate — and is never closed automatically: a person may be tracking
something no probe can see.

Every state change, whoever makes it, appends to the incident timeline. Changes
a *person* makes also write an `AuditLog` row naming them and recording the
before and after, readable by an administrator at `/api/users/audit/log`.

### Alerts on host resources

Sampled CPU, memory and disk usage are compared against configured thresholds on
every sample, and a breach sustained for `HOST_ALERT_SUSTAINED_SAMPLES`
consecutive samples opens a real `Incident` — the same records a person can open
by hand, visible on the same page, with the same timeline:

```
Memory pressure on Arman
  HIGH · AUTOMATED · open
  Memory on Arman is at 91.8%, at or above the 90% threshold
```

It resolves itself once usage stays below the threshold for
`HOST_ALERT_RECOVERY_SAMPLES` consecutive samples, and escalates to CRITICAL at
`HOST_ALERT_CRITICAL_PERCENT`. Incidents a person opened are never closed
automatically. Thresholds are per resource; see `backend/.env.example`.

---

## Scripts

### `backend/`

| Command | Purpose |
| :--- | :--- |
| `npm run dev` | Start with reload |
| `npm run build` | Generate the Prisma client and compile to `dist/` |
| `npm start` | Run the compiled output |
| `npm run typecheck` | Type-check without emitting |
| `npm run lint` | Type-aware ESLint |
| `npm run format` | Prettier |
| `npm test` | Unit and integration suites |
| `npm run test:unit` | Pure logic only; needs no database |
| `npm run test:integration` | Real HTTP against a real PostgreSQL |
| `npm run db:migrate` | Create/apply a migration in development |
| `npm run db:deploy` | Apply pending migrations (production) |
| `npm run db:seed` | First admin + service catalogue |
| `npm run db:studio` | Prisma Studio |

### `frontend/`

| Command | Purpose |
| :--- | :--- |
| `npm run dev` | Vite dev server on port 5174 (pinned) |
| `npm run build` | Type-check and produce a production bundle |
| `npm run preview` | Serve the production bundle locally |
| `npm run typecheck` | Type-check |
| `npm run lint` | ESLint |
| `npm run format` | Prettier |
| `npm test` | Vitest with jsdom and Testing Library |

---

## Tests

```bash
cd backend  && npm run test:unit         # no database required
docker compose up -d postgres            # for the integration suite
cd backend  && npm test
cd frontend && npm test
```

The backend integration suite runs against a real PostgreSQL database rather
than a mocked Prisma client, because every guarantee worth testing here lives in
the database: the partial unique index that deduplicates incidents, the
serializable transaction that stops the last administrator being removed, the
compare-and-swap that makes refresh-token rotation safe. A mocked client would
pass just as happily with all three removed.

It creates and migrates a `pulsara_test` database on first run, and refuses to
run against any database whose name does not end in `_test` — it truncates every
table between cases. Override the target with `TEST_DATABASE_URL`.

---

## Environment variables

Every variable is documented in `backend/.env.example` and
`frontend/.env.example`, and both are validated by a Zod schema at startup. A
missing or malformed value produces one line per problem and a non-zero exit —
it never falls back to a default.

Secrets are never committed. In production they come from AWS Secrets Manager
and GitHub Actions secrets.

---

## API

All routes below are under `/api`. The one exception is `GET /metrics` at the
root, which serves Prometheus text exposition — see **Monitoring** below.

Every response uses the same envelope:

```jsonc
{ "success": true,  "data": …, "meta": … }
{ "success": false, "error": { "code": "…", "message": "…", "requestId": "…" } }
```

| Method | Route | Auth | Purpose |
| :--- | :--- | :--- | :--- |
| `GET` | `/health` | — | Liveness; touches no dependency |
| `GET` | `/health/ready` | — | Readiness; pings the database |
| `POST` | `/auth/login` | — | Email + password, rate limited |
| `POST` | `/auth/firebase` | — | Exchange a Google ID token |
| `POST` | `/auth/refresh` | cookie | Rotate the session |
| `POST` | `/auth/logout` | cookie | Revoke the session |
| `GET` | `/auth/me` | Bearer | Current user, read from the database |
| `PATCH` | `/auth/me` | Bearer | Update own name or avatar |
| `POST` | `/auth/password` | Bearer | Change own password; revokes every session |
| `GET` | `/auth/sessions` | Bearer | List own live sessions |
| `DELETE` | `/auth/sessions` | Bearer | Sign out everywhere |
| `GET` | `/users` | ADMIN | List users (`role`, `isActive`) |
| `PATCH` | `/users/:id` | ADMIN | Change a role or deactivate an account |
| `GET` | `/users/audit/log` | ADMIN | Audit trail of privileged actions |
| `GET` | `/services` | Bearer | Catalogue, with uptime and latency derived from probes |
| `GET` | `/services/:id` | Bearer | One service plus its recent raw checks |
| `POST` | `/services` | ADMIN | Register a service to probe |
| `PATCH` | `/services/:id` | ADMIN | Update probe config or declare maintenance |
| `DELETE` | `/services/:id` | ADMIN | Remove a service and its probe history |
| `GET` | `/metrics/series` | Bearer | Downsampled telemetry (`from`, `to`, `types`, `maxPoints`) |
| `GET` | `/metrics/latest` | Bearer | Most recent sample of each metric family |
| `GET` | `/metrics/hosts` | Bearer | Hosts that have reported samples |
| `GET` | `/deployments` | Bearer | Workflow runs (`limit`, `offset`, `status`, `repo`, `branch`) |
| `GET` | `/deployments/stats` | Bearer | Success rate and median duration |
| `GET` | `/deployments/:id` | Bearer | One run with its jobs |
| `GET` | `/integrations/github/status` | Bearer | Whether polling and webhooks are configured |
| `GET` | `/integrations/github/connections` | Bearer | Connected repositories |
| `POST` | `/integrations/github/connections` | ADMIN | Connect a repository |
| `DELETE` | `/integrations/github/connections/:id` | ADMIN | Disconnect (history is kept) |
| `POST` | `/integrations/github/connections/:id/sync` | ADMIN | Force a sync now |
| `POST` | `/integrations/github/webhook` | signature | GitHub delivery endpoint |
| `GET` | `/incidents` | Bearer | Feed (`limit`, `offset`, `status`, `severity`, `serviceId`, `isOpen`) |
| `GET` | `/incidents/summary` | Bearer | Open/resolved counts by severity |
| `GET` | `/incidents/:id` | Bearer | One incident with its full timeline |
| `POST` | `/incidents` | MEMBER | Raise an incident by hand |
| `PATCH` | `/incidents/:id` | MEMBER | Change status, severity or assignee |
| `POST` | `/incidents/:id/comments` | MEMBER | Append a note to the timeline |

---

## Project status

Implemented: configuration and secrets hygiene, PostgreSQL with versioned
migrations, authentication with rotation and RBAC, the error contract,
structured logging, health probes, graceful shutdown, real host telemetry
collection with batched persistence, a Prometheus scrape endpoint, service
probing with a hysteresis state machine, derived uptime and latency percentiles,
retention, an authenticated realtime stream, alerting engines that open and
resolve incidents from observed outages, host resource pressure and failing
deliveries, a GitHub Actions
integration with signed webhooks and reconciling backfill, and a web client that
reads all of it through a single API layer with no token in `localStorage` and
no placeholder rows.

Container images, a working `docker compose` stack and GitHub Actions CI are in
place. [ARCHITECTURE.md](./ARCHITECTURE.md) tracks the current state precisely.

---

## Licence

MIT
