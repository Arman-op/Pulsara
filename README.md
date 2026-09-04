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
is off. A partial configuration is rejected at startup rather than silently
disabling the feature.

**1. Create the project and turn the provider on.** At
<https://console.firebase.google.com>, create a project, then under
*Build → Authentication → Sign-in method* enable **Google**.

**2. Authorise the origin the client is served from.** Under
*Authentication → Settings → Authorized domains*, add the host — `localhost` is
there by default, so local development needs nothing; a deployed client does.
Without it the popup opens and closes with `auth/unauthorized-domain`.

**3. Supply all of the following.**

In `backend/.env`, from *Project settings → Service accounts →
Generate new private key* (the private key is shown once):

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

The backend rejects a token whose email address the provider has not verified,
because an unverified address may belong to somebody else entirely and linking
it would let an attacker take over an existing account by claiming its email at
the identity provider.

The first account to exist in a deployment becomes `ADMIN`. Everyone after that
starts as `VIEWER` and must be promoted deliberately by an administrator through
`PATCH /api/users/:id`. Granting `ADMIN` to every federated sign-in — which the
original implementation did — turns "has a Google account" into "administers
this deployment".

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
| API | Prettier, ESLint, `npm audit`, `tsc`, unit tests, integration tests under coverage against real PostgreSQL and Redis service containers, build |
| Web | Prettier, ESLint, `npm audit`, `tsc`, Vitest under coverage, production build |
| End to end | Installs all three packages, then runs the Playwright suite in Chromium against the real API and the real client; uploads a trace on failure |
| Images | `docker build` for both images; pushes them to GHCR only from `main` |

Images are built on every run so a broken Dockerfile fails the pull request that
caused it, but published only from the default branch — a fork's pull request
must never be able to publish a tag a deployment might pull. Set the repository
variable `VITE_API_URL` to the origin the published client should talk to.

Coverage runs in CI rather than being reported by hand, and the thresholds in
`backend/vitest.config.ts` and `frontend/vite.config.ts` are floors set just
under what the suites reach today. A change that removes coverage fails the
build; a change that adds some raises the bar for the next one.

---

## Deployment

`.github/workflows/deploy.yml` releases to AWS on every push to `main`, and can
be re-run by hand from the Actions tab. It builds both images and pushes them to
ECR tagged with the commit SHA, applies pending Prisma migrations, moves the ECS
API service onto the new revision, waits for it to stabilise, then does the same
for the client.

Migrations run as a **one-off ECS task from the same task-definition revision
that is about to serve traffic** — same image, same secrets, same subnets —
rather than from the GitHub runner. That keeps one configuration instead of two,
and means the production database needs no public route into it.

### No AWS access keys

The workflow authenticates with **GitHub Actions OIDC**. There is no
`AWS_ACCESS_KEY_ID` or `AWS_SECRET_ACCESS_KEY` anywhere in this repository or
its secrets. GitHub mints a short-lived token describing the repository, ref and
workflow that asked for it, and an IAM role decides whether to trust it.

Both the identity provider and the role are declared in [`infra/`](./infra) —
`infra/iam.tf` — so this is not a console click somebody has to remember. The
condition that matters is the `sub`:

```json
"Condition": {
  "StringEquals": {
    "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
    "token.actions.githubusercontent.com:sub": "repo:<owner>/<repo>:ref:refs/heads/main"
  }
}
```

Without it, the provider vouches only that the token came from GitHub Actions —
not that it came from *this* repository — and any workflow anywhere could assume
the role. The policy attached to it grants ECR push, the ECS calls the release
makes, and `iam:PassRole` restricted to the two task roles and to
`ecs-tasks.amazonaws.com`, because naming a role is a form of using one and an
unrestricted `PassRole` is the standard way out of a deployment role.

### What to configure

Two secrets:

| Secret | Description |
| :--- | :--- |
| `AWS_DEPLOY_ROLE_ARN` | The release role above, on the `production` environment |
| `AWS_TERRAFORM_PLAN_ROLE_ARN` | The read-only role the infrastructure workflow plans with |

Everything else is a repository variable, because none of it is secret — and
none of it needs typing out, because Terraform prints it:

```bash
cd infra
terraform output -json github_actions_variables |
  jq -r 'to_entries[] | "gh variable set \(.key) --body \"\(.value)\""'
```

| Variable | Description |
| :--- | :--- |
| `AWS_REGION` | Region holding the registry and the cluster |
| `ECR_REPOSITORY_API` / `ECR_REPOSITORY_WEB` | ECR repository names |
| `ECS_CLUSTER` | Cluster name |
| `ECS_SERVICE_API` / `ECS_SERVICE_WEB` | Service names |
| `ECS_TASK_FAMILY_API` / `ECS_TASK_FAMILY_WEB` | Task-definition families |
| `ECS_CONTAINER_API` / `ECS_CONTAINER_WEB` | Container names inside those definitions |
| `ECS_SUBNET_IDS` | Comma-separated subnets for the migration task |
| `ECS_SECURITY_GROUP_IDS` | Comma-separated security groups for it |
| `VITE_API_URL` | Origin the published client talks to (inlined at build time) |
| `VITE_FIREBASE_*` | Optional; enables Google sign-in in the published bundle |
| `PRODUCTION_API_URL` | Optional; if set, the deploy checks `/api/health` afterwards |
| `TF_STATE_BUCKET` / `TF_STATE_KEY` | Where the Terraform state lives, for the plan job |
| `PRODUCTION_DOMAIN_NAME` / `ROUTE53_ZONE_ID` | Passed to `terraform plan` as variables |

Application secrets — `DATABASE_URL`, the JWT secrets, the Firebase service
account, the GitHub App key — are **not** passed by this workflow. They belong
in AWS Secrets Manager and are referenced by the task definition's `secrets`
block, so they are never in a GitHub log, a workflow file, or an image layer.

> **Not verified.** This pipeline has never been run. Doing so needs the AWS
> account [`infra/`](./infra) describes, and this repository has none. The
> workflow is a reviewable design for a release, not something anybody has
> watched go green.

---

## Infrastructure

[`infra/`](./infra) is Terraform for the account all of the above assumes: a VPC
across two availability zones, an ECS Fargate cluster running the two services,
an Application Load Balancer terminating HTTPS on an ACM certificate, RDS
PostgreSQL and ElastiCache Redis in private subnets, ECR repositories, and the
Secrets Manager entries the tasks read at start-up.

Public subnets hold exactly one thing: the load balancer. Everything else — both
services, the database, the cache — sits in private subnets with no inbound
route, so the reachable surface of the deployment is two ports. There is no
bastion; migrations run as a one-off task on the API's own security group, and a
shell in a running container is ECS Exec.

The names the release workflow needs are Terraform outputs rather than something
to copy by hand, which is what stops a release pointing at a cluster that no
longer exists.

`.github/workflows/infra.yml` runs `fmt`, `validate` and a **`terraform plan`**
on every pull request touching `infra/`. Nothing applies on its own: no push,
merge or schedule reaches the apply job, which needs a manual dispatch *and* an
approval from the `infrastructure` environment's reviewers. The role it assumes
is deliberately not declared in the configuration it applies — creating IAM
roles is indistinguishable from administrator access, and a configuration that
declares the role used to apply it is a loop with an account takeover in the
middle.

[infra/README.md](./infra/README.md) has the bootstrap order, and a table of
every choice with a price attached — single NAT gateway, Multi-AZ, Spot,
Graviton — with what each one costs and what it buys.

> **Not verified**, in the same sense as the release workflow: it formats,
> initialises and validates in CI, but no `terraform apply` has ever run.

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

### Scaling out

Probing and caching both use Redis when `REDIS_URL` is set, and neither is
required:

```
REDIS_URL=redis://localhost:6380
```

Without it, probes run on an in-process timer and reads go to PostgreSQL — right
for one instance, wrong for several, because every replica would probe every
service and multiply load on the endpoints being measured. With it, a BullMQ
repeatable job sweeps once across the fleet while the probes spread over every
instance, and `/api/services` and `/api/deployments` are served from a
short-lived cache that every write invalidates.

`docker compose up -d` starts Redis on 6380 alongside PostgreSQL on 5433.

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
| `npm run test:integration` | Real HTTP against a real PostgreSQL and Redis |
| `npm run test:coverage` | Both suites, with the CI coverage floor enforced |
| `npm run db:migrate` | Create/apply a migration in development |
| `npm run db:deploy` | Apply pending migrations (production) |
| `npm run db:seed` | First admin + service catalogue |
| `npm run db:studio` | Prisma Studio |

### `e2e/`

| Command | Purpose |
| :--- | :--- |
| `npm run install:browsers` | Download Chromium (once) |
| `npm test` | Start both servers and drive a real browser |
| `npm run test:headed` | The same, with the browser visible |

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
| `npm run test:coverage` | The same, with the CI coverage floor enforced |

---

## Tests

```bash
cd backend  && npm run test:unit   # no infrastructure required
docker compose up -d               # PostgreSQL and Redis, for the integration suite
cd backend  && npm run test:coverage
cd frontend && npm run test:coverage

cd e2e && npm ci && npm run install:browsers
npm test                           # starts both servers itself
```

| Suite | What it drives | Count |
| :--- | :--- | ---: |
| `backend/tests/unit` | Pure decision logic, no infrastructure | 52 |
| `backend/tests/integration` | Real Express over HTTP, real PostgreSQL and Redis | 204 |
| `frontend/src/**/*.test.tsx` | React in jsdom, `fetch` stubbed | 55 |
| `e2e` | Real Chromium against the real stack | 6 |

The backend integration suite runs against a real PostgreSQL database rather
than a mocked Prisma client, because every guarantee worth testing here lives in
the database: the partial unique index that deduplicates incidents, the
serializable transaction that stops the last administrator being removed, the
compare-and-swap that makes refresh-token rotation safe. A mocked client would
pass just as happily with all three removed.

It creates and migrates a `pulsara_test` database on first run, and refuses to
run against any database whose name does not end in `_test` — it truncates every
table between cases. Override the target with `TEST_DATABASE_URL`.

The browser suite covers what neither of the others can. The API tests have no
browser and the component tests have no server, so neither would notice the two
sides disagreeing — a refresh cookie the browser declines to store, a CORS origin
that does not match, a socket handshake authenticated differently at each end.
Playwright starts both servers itself against a database of its own, so it runs
from a clean checkout with only Docker up. Its central assertion is a CPU figure
that *changes*: a token held only in memory authenticated a socket handshake, the
server accepted it, and a real `systeminformation` reading arrived.

Coverage thresholds are enforced in CI and set just below what the suites reach,
so they ratchet upward rather than becoming something to lower. The client's
figure is lower than the API's on purpose — its logic-carrying modules are above
90%, and five list screens are mostly JSX covered by the browser suite instead.

The cache and probe-queue suites need Redis, for the same reason the rest need
PostgreSQL: what is worth testing there — that invalidation actually deletes,
that two schedulers do not double-probe — is behaviour of the broker, not of the
code calling it. Override
with `TEST_REDIS_URL`.

---

## Security posture

| Control | How |
| :--- | :--- |
| Password storage | argon2id, OWASP parameters pinned explicitly |
| Access token | 15 minutes, held in memory only, never in `localStorage` |
| Refresh token | HttpOnly cookie scoped to `/api/auth`, rotated on every use |
| Replay | A rotated token presented again revokes the whole family |
| Sign out everywhere | Refuses access tokens issued before the moment of revocation |
| Every request | Role, active flag and revocation stamp read from the account, not the token |
| Authorisation | Role-ranked, enforced per route and covered by a generated matrix test |
| Input | Zod on every body and query, one error envelope |
| Webhooks | HMAC-SHA256 over raw bytes, `timingSafeEqual` |
| Dependencies | `npm audit` in CI on production dependencies, with a justified allowlist |

Run the dependency gate locally with `npm run audit` in either package.

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
deliveries, a GitHub Actions integration with signed webhooks and reconciling
backfill, a distributed probe queue and read cache on Redis, session revocation
enforced on every request, a dependency audit gate, and a web client that reads
all of it through a single API layer with no token in `localStorage` and no
placeholder rows.

Two paths are implemented but **have never been run against the live third
party**: Google sign-in against a real Firebase project, and GitHub polling
against a real repository token. Both are covered by tests that stub exactly one
function each, so everything Pulsara itself does is exercised — but nobody has
watched either work end to end, and this README is not going to claim otherwise.

Container images, a working `docker compose` stack, GitHub Actions CI, an
OIDC-authenticated release workflow and Terraform for the account it deploys to
are in place — the last two written and validated but never run, for want of an
AWS account.
[ARCHITECTURE.md](./ARCHITECTURE.md) tracks the current state precisely,
including what has not been verified.

---

## Licence

MIT
