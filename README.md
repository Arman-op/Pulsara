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
- **Docker** (for PostgreSQL), or an existing PostgreSQL 14+ instance

---

## Quick start

### 1. Start PostgreSQL

```bash
docker run -d --name pulsara-postgres-dev \
  -e POSTGRES_USER=pulsara \
  -e POSTGRES_PASSWORD=pulsara_local_dev \
  -e POSTGRES_DB=pulsara \
  -p 5433:5432 \
  postgres:16-alpine
```

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

**1. Create a token.** A fine-grained personal access token with **Actions:
Read-only** on the repositories you want to mirror. Put it in `backend/.env`:

```
GITHUB_TOKEN=github_pat_...
```

**2. Connect a repository** (as an `ADMIN` user):

```bash
curl -X POST http://localhost:4000/api/integrations/github/connections \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"owner":"your-org","name":"your-repo"}'
```

The repository is verified against the API before it is stored, so a typo fails
immediately instead of becoming a connection that silently never syncs. Recent
runs are backfilled straight away.

**3. Add a webhook (optional, for live updates).** In the repository's
*Settings → Webhooks*:

- Payload URL: `https://your-host/api/integrations/github/webhook`
- Content type: `application/json`
- Secret: generate with `openssl rand -base64 32` and set the same value as
  `GITHUB_WEBHOOK_SECRET` in `backend/.env`
- Events: **Workflow runs** and **Workflow jobs**

Deliveries without a valid HMAC-SHA256 signature are rejected. Polling still
reconciles anything a missed delivery would have lost, so webhooks are an
optimisation rather than a requirement.

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

All routes are under `/api`. Every response uses the same envelope:

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
collection, service probing with a hysteresis state machine, derived uptime and
latency percentiles, retention, an authenticated realtime stream, and an
alerting engine that opens and resolves incidents from observed outages, and a
GitHub Actions integration with signed webhooks and reconciling backfill.

Not yet implemented: automated tests, and container images with CI.
[ARCHITECTURE.md](./ARCHITECTURE.md) tracks the current state precisely.

---

## Licence

MIT
