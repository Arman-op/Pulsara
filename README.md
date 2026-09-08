# Pulsara

<div align="center">

**Real-Time DevOps & Infrastructure Intelligence Platform**

[![Node.js](https://img.shields.io/badge/Node.js-v22+-339933?style=flat&logo=node.js&logoColor=white)](https://nodejs.org/)
[![React](https://img.shields.io/badge/React-v19-61DAFB?style=flat&logo=react&logoColor=black)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?style=flat&logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Redis](https://img.shields.io/badge/Redis-7-DC382D?style=flat&logo=redis&logoColor=white)](https://redis.io/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-3.4-06B6D4?style=flat&logo=tailwindcss&logoColor=white)](https://tailwindcss.com/)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?style=flat&logo=docker&logoColor=white)](https://www.docker.com/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

*Pulsara monitors real host telemetry, distributed service reachability, GitHub Actions CI/CD pipelines, and automated incident lifecycles — with zero fabricated data.*

</div>

---

## Table of Contents

- [About The Project](#about-the-project)
  - [The Zero-Mock Principle](#the-zero-mock-principle)
  - [Key Capabilities](#key-capabilities)
  - [What Pulsara Is Not](#what-pulsara-is-not)
- [System Architecture](#system-architecture)
- [Technology Stack](#technology-stack)
- [Prerequisites](#prerequisites)
- [Installation & Setup](#installation--setup)
  - [Method 1: Local Development (Recommended)](#method-1-local-development-recommended)
  - [Method 2: Full Docker Stack (Single Command)](#method-2-full-docker-stack-single-command)
  - [Method 3: Native Setup (Without Docker)](#method-3-native-setup-without-docker)
- [Environment Configuration](#environment-configuration)
  - [Backend (`backend/.env`)](#backend-backendenv)
  - [Frontend (`frontend/.env`)](#frontend-frontendenv)
  - [Generating Cryptographic Secrets](#generating-cryptographic-secrets)
- [Integrations Setup](#integrations-setup)
  - [GitHub Actions CI/CD Integration](#1-github-actions-cicd-integration)
  - [Google Single Sign-On (Firebase Auth)](#2-google-single-sign-on-firebase-auth)
  - [Email & OTP Verification (SMTP)](#3-email--otp-verification-smtp)
- [Database Management](#database-management)
- [Monitoring & Prometheus Exposition](#monitoring--prometheus-exposition)
- [Testing & Quality Assurance](#testing--quality-assurance)
- [REST API Reference](#rest-api-reference)
- [Project Directory Structure](#project-directory-structure)
- [Troubleshooting & FAQs](#troubleshooting--faqs)
- [License](#license)

---

## About The Project

**Pulsara** is an enterprise-grade, real-time DevOps and infrastructure intelligence platform designed to provide complete observability over modern application environments. It brings host system telemetry, distributed service probing, live GitHub Actions deployments, and incident tracking into a unified, responsive, dark-mode glassmorphic dashboard.

### The Zero-Mock Principle

> **Core Rule:** *The UI never displays a value the system did not actually observe.*

Many dashboards rely on synthetic data, randomized charts (`Math.random()`), or hardcoded `99.9%` uptime figures. Pulsara rejects this entirely:
- If a service has not been probed yet, its uptime renders an **em dash (`—`)**, not a fabricated percentage.
- Host CPU, memory, and disk curves represent **actual OS performance counters** sampled in real time.
- Pipelines display **real GitHub Actions workflow runs and jobs** mirrored through authenticated APIs and signed webhooks. If unconfigured, the view clearly indicates it is disconnected rather than inventing placeholder rows.
- Incidents are opened by **real threshold breaches** or probe failures, complete with an immutable timeline and full audit logs.

### Key Capabilities

1. **Host Hardware & OS Telemetry**:
   - Powered by `systeminformation`, reading real CPU utilization, memory pressure, disk consumption, network I/O, and load averages every 2 seconds.
   - Live samples stream directly to the browser via an authenticated WebSocket connection (Socket.IO).
   - Time-series aggregation writes the 30-second window mean to PostgreSQL, avoiding database bloat while preserving high-resolution trends.

2. **Distributed Service Health Probing**:
   - Actively probes registered HTTP/HTTPS health-check endpoints using a distributed Redis + BullMQ scheduler (with an automatic in-process fallback for single-instance setups).
   - Uptime ratios and latency percentiles (such as p95) are calculated dynamically on-demand from verified historical check records.
   - Built-in failure and recovery hysteresis prevents transient network blips from triggering false outages.

3. **CI/CD Pipeline Mirroring (GitHub Actions)**:
   - Synchronizes repository workflow runs and individual job stages.
   - Employs HMAC-SHA256 signed webhooks for real-time updates and a background reconciling poller to catch missed deliveries.
   - Automatic startup backfill ensures your pipelines page has instant historical data on first boot.

4. **Intelligent Incident Lifecycle & Audit Logging**:
   - **Automated incidents** trigger on sustained host saturation, consecutive probe failures, or broken default branch builds, with automatic recovery once healthy.
   - **Manual incidents** allow engineers to log, assign, discuss, and track arbitrary operational events.
   - Automated escalation promotes severity to `CRITICAL` during prolonged or high-impact conditions.
   - Full timeline history and audit logging record who did what and when.

5. **Enterprise Security & Role-Based Access Control (RBAC)**:
   - Passwords hashed with **Argon2id** using strict OWASP-recommended parameters.
   - 15-minute in-memory JWT access tokens combined with rotating HttpOnly refresh cookies scoped to `/api/auth`.
   - Token family reuse detection revokes all active sessions if an already-rotated token is presented.
   - Multi-tier roles (`ADMIN`, `MEMBER`, `VIEWER`) enforced through route middleware and checked against the database on every authenticated request.
   - Optional Google SSO via Firebase Authentication and email one-time password (OTP) verification with domain restrictions.

6. **Prometheus & Observability Ready**:
   - Exposes standard Prometheus text metrics at `GET /metrics` in native base units (seconds, bytes, ratios 0..1).
   - Structured JSON application logging via `pino` with correlated `requestId` tracking across all HTTP and background operations.

### What Pulsara Is Not

Pulsara is designed for targeted node and endpoint observability:
- It is **not** a multi-cluster Kubernetes fleet manager.
- It monitors the host its API is hosted on (or the container's view of that host), alongside any external HTTP endpoints you explicitly configure.

---

## System Architecture

```mermaid
graph LR
    subgraph Browser["Client Application"]
        SPA["React 19 SPA<br/>(Tailwind CSS + Recharts + Zustand)"]
    end

    subgraph API["Pulsara API · Node 22"]
        HTTP["Express 5 REST API<br/>(/api/* & /metrics)"]
        WS["Socket.IO Server<br/>(Live Telemetry)"]
        COL["Host Collector<br/>(Every 2s via systeminformation)"]
        ENG["Alert & Incident Engine"]
        SYNC["GitHub Sync<br/>(Webhooks & Poller)"]
        QUEUE["BullMQ Probe Scheduler"]
    end

    subgraph Storage["State & Caching"]
        DB[("PostgreSQL 16<br/>(Prisma ORM)")]
        REDIS[("Redis 7<br/>(Queue & Read Cache)")]
    end

    subgraph External["Monitored Targets"]
        HOST["Host System<br/>(CPU, Memory, Disk, Network)"]
        SERVICES["Registered Endpoints<br/>(HTTP/HTTPS Health Checks)"]
        GH["GitHub Actions<br/>(Workflow Runs & Jobs)"]
        PROM["Prometheus Scraper"]
    end

    SPA -->|"REST (Bearer JWT)"| HTTP
    WS -.->|"Live 2s Telemetry"| SPA

    HOST --> COL
    COL --> WS
    COL -->|"30s Window Mean"| DB
    COL --> ENG

    QUEUE -->|"Scheduled Probes"| SERVICES
    SERVICES -->|"Latency & Status"| DB
    SERVICES --> ENG

    GH -->|"Signed Webhooks (HMAC-SHA256)"| HTTP
    SYNC <-->|"Reconciling Poll"| GH
    SYNC --> DB
    SYNC --> ENG

    ENG -->|"Incidents & Timeline"| DB
    HTTP <--> DB
    HTTP <-->|"Read-Through Cache"| REDIS
    REDIS <--> QUEUE
    PROM -->|"Scrape GET /metrics"| HTTP
```

---

## Technology Stack

| Layer | Technologies | Purpose |
| :--- | :--- | :--- |
| **Frontend UI** | React 19, TypeScript, Vite 6 | High-performance reactive Single Page Application |
| **Styling & Design** | Tailwind CSS 3.4, Lucide React | Glassmorphic dark obsidian UI design system |
| **Client State** | Zustand, LocalStorage Persistence | Auth session and transient UI store management |
| **Visualizations** | Recharts | Live responsive area charts for CPU, Memory, and Network |
| **Backend Runtime** | Node.js 22+, Express 5, TypeScript, `tsx` | Robust REST API server & real-time streaming engine |
| **Real-Time Stream** | Socket.IO (v4) | Bidirectional WebSocket telemetry streaming |
| **Database & ORM** | PostgreSQL 16, Prisma ORM (v6) | Relational persistence with versioned schema migrations |
| **Queue & Cache** | Redis 7, BullMQ, `ioredis` | Distributed endpoint probe scheduling & read-through cache |
| **Host Metrics** | `systeminformation`, `prom-client` | Deep hardware counter sampling & Prometheus exposition |
| **Authentication** | `@node-rs/argon2`, `jsonwebtoken`, Firebase Admin | Argon2id password hashing, JWTs, Google OAuth 2.0 |
| **Email & OTP** | Nodemailer, Crypto SHA-256 | Verification codes for sign-up and password reset |
| **Observability** | Pino, Pino-HTTP | Structured JSON logging with request ID correlation |
| **Testing** | Vitest, React Testing Library, Supertest, Playwright | Unit, integration (real DB/Redis), and E2E browser tests |
| **Containerization** | Docker, Multi-Stage Dockerfiles, Docker Compose | Isolated, production-ready lightweight container images |

---

## Prerequisites

Before setting up Pulsara, ensure your development machine has the following installed:

- **Node.js**: Version `22.0.0` or later ([Download Node.js](https://nodejs.org/))
- **npm**: Version `10.0.0` or later (bundled with Node 22)
- **Docker & Docker Compose**: Version 2.0+ ([Download Docker](https://www.docker.com/))
- **Git**: For cloning and version control ([Download Git](https://git-scm.com/))
- **OpenSSL**: For generating secure cryptographic secrets (pre-installed on Linux/macOS; available via Git Bash / PowerShell on Windows)

---

## Installation & Setup

You can run Pulsara using any of the following three workflows:

### Method 1: Local Development (Recommended)

This method runs PostgreSQL and Redis inside Docker while executing the backend and frontend dev servers directly on your host machine for fast live reload and debugging.

#### Step 1: Clone the Repository

```bash
git clone https://github.com/Arman-op/Pulsara.git
cd Pulsara
```

#### Step 2: Spin Up PostgreSQL and Redis

Start the backing data stores using Docker Compose:

```bash
docker compose up -d
```

This starts:
- **PostgreSQL 16** on host port `5433` (mapped from container `5432` to avoid conflicts with existing native PostgreSQL installations).
- **Redis 7** on host port `6380` (mapped from container `6379` to avoid conflicts with native Redis installations).

Verify containers are running and healthy:
```bash
docker compose ps
```

#### Step 3: Backend Setup

1. Navigate to the backend directory and install dependencies:
   ```bash
   cd backend
   npm install
   ```

2. Create your local environment file:
   ```bash
   cp .env.example .env
   ```

3. Generate secure cryptographic secrets for JWT tokens:
   ```bash
   # Run in your shell (Linux / macOS / Git Bash / PowerShell):
   openssl rand -base64 48
   openssl rand -base64 48
   ```
   Open `backend/.env` and paste the generated strings into:
   - `JWT_ACCESS_SECRET`
   - `JWT_REFRESH_SECRET`

4. Set your initial administrator password in `backend/.env`:
   ```ini
   SEED_ADMIN_EMAIL=admin@pulsara.dev
   SEED_ADMIN_PASSWORD=YourStrongPassword123!
   ```

5. Apply database migrations and seed default data:
   ```bash
   npm run db:deploy   # Applies Prisma schema migrations
   npm run db:seed     # Seeds initial admin user and real probe targets
   ```

6. Start the backend development server:
   ```bash
   npm run dev
   ```
   *The API will start at **http://localhost:4000**.*

7. Confirm backend health in a new terminal:
   ```bash
   curl http://localhost:4000/api/health/ready
   # Expected response: {"success":true,"data":{"status":"ready","database":"connected"}}
   ```

#### Step 4: Frontend Setup

1. Open a new terminal, navigate to the frontend directory, and install dependencies:
   ```bash
   cd frontend
   npm install
   ```

2. Create the frontend environment configuration:
   ```bash
   cp .env.example .env
   ```
   *The default `VITE_API_URL=http://localhost:4000` is already configured for local development.*

3. Start the Vite development server:
   ```bash
   npm run dev
   ```
   *The client will start at **http://localhost:5174**.*

#### Step 5: Access the Dashboard

1. Open your browser and navigate to: **`http://localhost:5174`**
2. Sign in with the credentials seeded in Step 3:
   - **Email**: `admin@pulsara.dev`
   - **Password**: Your configured `SEED_ADMIN_PASSWORD` (e.g., `YourStrongPassword123!`)
3. You will be greeted by the live dashboard streaming actual host hardware metrics and real-time service health checks!

---

### Method 2: Full Docker Stack (Single Command)

If you prefer to run the entire stack (Frontend, Backend, Database, and Redis) containerized without installing local Node dependencies:

1. Copy and configure the environment file:
   ```bash
   cp backend/.env.example backend/.env
   ```
2. Edit `backend/.env` and ensure `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` are populated with random keys (e.g., using `openssl rand -base64 48`).
3. Build and launch all containers using the `app` Docker profile:
   ```bash
   docker compose --profile app up --build
   ```
4. Access the applications:
   - **Web UI**: `http://localhost:5174`
   - **API Server**: `http://localhost:4000`
   - **Prometheus Metrics**: `http://localhost:4000/metrics`

*To stop the containers:*
```bash
docker compose --profile app down
```

---

### Method 3: Native Setup (Without Docker)

If you already have native PostgreSQL and Redis instances running on your machine or in the cloud:

1. Ensure PostgreSQL (v14+) and Redis (v6+) are accessible.
2. In `backend/.env`, configure your connection strings:
   ```ini
   DATABASE_URL=postgresql://<user>:<password>@<host>:<port>/<dbname>?schema=public
   REDIS_URL=redis://<host>:<port>
   ```
3. Run the standard backend setup:
   ```bash
   cd backend
   npm install
   npm run db:deploy
   npm run db:seed
   npm run dev
   ```
4. Run the frontend setup:
   ```bash
   cd frontend
   npm install
   npm run dev
   ```

---

## Environment Configuration

All environment variables are validated at startup with strict **Zod schemas**. If a required variable is missing or malformed, the application will exit immediately with an explicit error detailing the exact issue.

### Backend (`backend/.env`)

| Variable | Required | Default | Description |
| :--- | :---: | :---: | :--- |
| `NODE_ENV` | No | `development` | Application environment (`development`, `test`, `production`). |
| `PORT` | No | `4000` | Port for the HTTP & WebSocket server. |
| `LOG_LEVEL` | No | `debug` | Logger verbosity (`fatal`, `error`, `warn`, `info`, `debug`, `trace`). |
| `DATABASE_URL` | **Yes** | — | PostgreSQL connection string. Must start with `postgresql://`. |
| `TEST_DATABASE_URL` | No | — | Database for integration tests. Must end with `_test`. |
| `CORS_ORIGINS` | **Yes** | `http://localhost:5174` | Comma-separated list of allowed browser origins. Wildcards are rejected. |
| `RATE_LIMIT_WINDOW_MS` | No | `60000` | Window in milliseconds for global API rate limiting. |
| `RATE_LIMIT_MAX_REQUESTS`| No | `300` | Max requests allowed per IP per rate limit window. |
| `JWT_ACCESS_SECRET` | **Yes** | — | 32+ char secret for signing short-lived JWT access tokens. |
| `JWT_REFRESH_SECRET` | **Yes** | — | 32+ char secret for refresh tokens (must differ from access secret). |
| `ACCESS_TOKEN_TTL_SECONDS`| No | `900` | Access token lifespan in seconds (default: 15 minutes). |
| `REFRESH_TOKEN_TTL_DAYS` | No | `7` | Refresh token lifespan in days. |
| `METRICS_COLLECTION_ENABLED`| No | `true` | Enables periodic host OS counter sampling via `systeminformation`. |
| `METRICS_SAMPLE_INTERVAL_MS`| No | `2000` | Sampling frequency for host hardware metrics (in ms). |
| `METRICS_PERSIST_INTERVAL_MS`| No | `30000`| Interval for persisting windowed mean metrics to PostgreSQL. |
| `HOST_ALERTS_ENABLED` | No | `true` | Enables automated incident creation on host saturation breaches. |
| `CPU_ALERT_THRESHOLD_PERCENT`| No | `90` | CPU utilization percentage threshold to trigger an incident. |
| `MEMORY_ALERT_THRESHOLD_PERCENT`| No | `90` | Memory usage percentage threshold to trigger an incident. |
| `DISK_ALERT_THRESHOLD_PERCENT`| No | `85` | Disk usage percentage threshold to trigger an incident. |
| `HOST_ALERT_CRITICAL_PERCENT`| No | `97` | Utilization threshold to escalate an open incident to `CRITICAL`. |
| `PROMETHEUS_METRICS_ENABLED`| No | `true` | Exposes Prometheus scrape endpoint at `GET /metrics`. |
| `METRICS_SCRAPE_TOKEN` | No | — | Optional Bearer token to protect `GET /metrics` in public networks. |
| `REDIS_URL` | No | `redis://localhost:6380`| Connection URL for Redis. Enables BullMQ queue and read cache. |
| `PROBES_ENABLED` | No | `true` | Enables scheduled HTTP health-check probing for registered services. |
| `SERVICE_FAILURE_THRESHOLD`| No | `3` | Consecutive failed checks required before declaring a service offline. |
| `SERVICE_RECOVERY_THRESHOLD`| No | `2` | Consecutive successful checks required to restore service status. |
| `SERVICE_DEGRADED_LATENCY_MS`| No | `1000`| Latency threshold (ms) above which a service is marked `DEGRADED`. |
| `SEED_ADMIN_EMAIL` | No | `admin@pulsara.dev` | Email used when executing `npm run db:seed`. |
| `SEED_ADMIN_PASSWORD` | **Yes** (seed) | — | Password for the seeded admin user (minimum 12 characters). |
| `GITHUB_MONITORED_REPO` | No | `Arman-op/Pulsara` | `owner/repo` to mirror on the CI/CD Pipelines screen. |
| `GITHUB_TOKEN` | No | — | Fine-grained Personal Access Token with Actions/Metadata read permissions. |
| `GITHUB_APP_ID` | No | — | GitHub App ID (alternative to `GITHUB_TOKEN`). |
| `GITHUB_APP_PRIVATE_KEY` | No | — | GitHub App RSA Private Key string. |
| `GITHUB_WEBHOOK_SECRET` | No | — | Secret to verify incoming GitHub webhook HMAC signatures. |
| `AUTH_SIGNUP_ENABLED` | No | `true` | Allows new users to self-register via email OTP verification. |
| `AUTH_SIGNUP_ALLOWED_DOMAINS`| No | — | Restricts signups to specific email domains (e.g. `company.com`). |
| `SMTP_HOST` | No | — | SMTP host for sending verification and password reset codes. |
| `SMTP_PORT` | No | `587` | SMTP port (587 for STARTTLS, 465 for SSL/TLS). |
| `SMTP_USER` | No | — | SMTP authentication username. |
| `SMTP_PASSWORD` | No | — | SMTP authentication password. |
| `MAIL_FROM` | No | — | Sender address (e.g. `Pulsara <no-reply@yourdomain.com>`). |

### Frontend (`frontend/.env`)

| Variable | Required | Default | Description |
| :--- | :---: | :---: | :--- |
| `VITE_API_URL` | **Yes** | `http://localhost:4000` | Base origin of the Pulsara API for REST and WebSockets. |
| `VITE_FIREBASE_API_KEY` | No | — | Firebase web client API key (enables Google Sign-In button). |
| `VITE_FIREBASE_AUTH_DOMAIN` | No | — | Firebase authentication domain. |
| `VITE_FIREBASE_PROJECT_ID` | No | — | Firebase project ID. |
| `VITE_FIREBASE_APP_ID` | No | — | Firebase application ID. |

### Generating Cryptographic Secrets

Always generate high-entropy random secrets for your deployments:

```bash
# JWT Secrets (run twice to produce distinct keys):
openssl rand -base64 48

# GitHub Webhook Secret:
openssl rand -base64 32

# Prometheus Scrape Token:
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

---

## Integrations Setup

### 1. GitHub Actions CI/CD Integration

Pulsara mirrors GitHub Actions workflows and jobs in real time.

1. **Choose an Authentication Credential** (Configure exactly one):
   - **Option A: Personal Access Token (PAT)** (Quickest for local dev)
     - Create a fine-grained PAT at [GitHub Settings > Personal Access Tokens](https://github.com/settings/tokens?type=beta).
     - Grant **Repository permissions**: `Actions: Read-only` and `Metadata: Read-only`.
     - In `backend/.env`:
       ```ini
       GITHUB_TOKEN=github_pat_your_token_here
       GITHUB_MONITORED_REPO=your-org/your-repo
       ```
   - **Option B: GitHub App** (Recommended for production)
     - Create an app at [GitHub Settings > Developer Settings > GitHub Apps](https://github.com/settings/apps).
     - Permissions: `Actions: Read-only`, `Metadata: Read-only`.
     - Subscribe to events: **Workflow run** and **Workflow job**.
     - Download the private `.pem` file and convert to a single-line string:
       ```bash
       node -e "console.log(JSON.stringify(require('fs').readFileSync('app.pem','utf8')))"
       ```
     - In `backend/.env`:
       ```ini
       GITHUB_APP_ID=123456
       GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----\n"
       GITHUB_MONITORED_REPO=your-org/your-repo
       ```

2. **Configure Live Webhooks (Optional but Recommended)**:
   - In your repository under *Settings > Webhooks > Add webhook*:
     - **Payload URL**: `https://your-domain.com/api/integrations/github/webhook`
     - **Content type**: `application/json`
     - **Secret**: Set a random secret and assign the same value to `GITHUB_WEBHOOK_SECRET` in `backend/.env`.
     - **Events**: Select *Workflow runs* and *Workflow jobs*.

---

### 2. Google Single Sign-On (Firebase Auth)

Enable one-click Google OAuth 2.0 logins:

1. In the [Firebase Console](https://console.firebase.google.com), create a project.
2. Under *Build > Authentication > Sign-in method*, enable **Google**.
3. Under *Settings > Authorized domains*, ensure your client domain (`localhost` for dev, your production domain for deployed environments) is listed.
4. Download service account credentials from *Project Settings > Service accounts > Generate new private key*.
5. In `backend/.env`, supply:
   ```ini
   FIREBASE_PROJECT_ID=your-project-id
   FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxx@your-project-id.iam.gserviceaccount.com
   FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
   ```
6. In `frontend/.env`, supply your client SDK keys from *Project Settings > General > Your apps*:
   ```ini
   VITE_FIREBASE_API_KEY=AIzaSy...
   VITE_FIREBASE_AUTH_DOMAIN=your-project-id.firebaseapp.com
   VITE_FIREBASE_PROJECT_ID=your-project-id
   VITE_FIREBASE_APP_ID=1:xxx:web:xxx
   ```

*Role Provisioning Rule:* The very first user created in a deployment automatically receives the `ADMIN` role. All subsequent registrations start as `VIEWER` and must be elevated by an administrator.

---

### 3. Email & OTP Verification (SMTP)

Pulsara supports self-service signup and password resets backed by 6-digit numeric OTP verification codes:

1. In `backend/.env`, configure outbound SMTP settings:
   ```ini
   AUTH_SIGNUP_ENABLED=true
   AUTH_SIGNUP_ALLOWED_DOMAINS=yourcompany.com,partner.org
   SMTP_HOST=smtp.mailgun.org
   SMTP_PORT=587
   SMTP_USER=postmaster@yourcompany.com
   SMTP_PASSWORD=your-smtp-password
   MAIL_FROM="Pulsara <no-reply@yourcompany.com>"
   ```
2. One-time codes are stored as salted SHA-256 digests in the database, feature an automatic 10-minute expiry (`OTP_TTL_MINUTES=10`), a 5-attempt brute-force limit (`OTP_MAX_ATTEMPTS=5`), and a 60-second resend cooldown to protect mail reputation.

---

## Database Management

Pulsara uses **Prisma ORM** with versioned PostgreSQL migrations.

### Common Database Commands (`backend/`)

| Command | Action |
| :--- | :--- |
| `npm run db:deploy` | Applies all pending migrations to the database (safe for production). |
| `npm run db:migrate` | Generates a new migration from `schema.prisma` in development. |
| `npm run db:seed` | Populates the database with default administrator and initial probe endpoints. |
| `npm run db:studio` | Launches Prisma Studio GUI in your browser at `http://localhost:5555`. |
| `npm run db:generate` | Regenerates the `@prisma/client` library based on the current schema. |

### Core Data Models

- **`User`**: Account identity, email, password hash, role (`ADMIN`, `MEMBER`, `VIEWER`), avatar, and verification timestamp.
- **`RefreshToken`**: Session tracking with rotating SHA-256 token hash and expiration.
- **`OtpCode`**: Short-lived hashed one-time codes for email verification and password reset.
- **`Service`**: Registered endpoints to probe with URL, interval, and health status.
- **`ProbeResult`**: Historical log of status code, latency, and error per probe execution.
- **`HostMetric`**: 30-second windowed aggregated host telemetry (CPU, memory, disk, network, load).
- **`Deployment` & `Stage`**: Mirrored GitHub Actions workflow runs and individual steps.
- **`Incident` & `IncidentTimeline`**: Operational alerts, lifecycle transitions, notes, and severity changes.
- **`AuditLog`**: Tamper-evident record of administrative changes and manual incident updates.

---

## Monitoring & Prometheus Exposition

Pulsara exposes self-monitoring metrics adhering to official Prometheus text exposition specifications:

```bash
curl -s http://localhost:4000/metrics | grep '^pulsara_'
```

### Sample Output

```
pulsara_host_cpu_usage_ratio{host="pulsara-node-1"} 0.1845
pulsara_host_memory_usage_ratio{host="pulsara-node-1"} 0.6420
pulsara_host_disk_usage_ratio{host="pulsara-node-1"} 0.5218
pulsara_host_sample_age_seconds{host="pulsara-node-1"} 1.820
pulsara_service_up{service="Pulsara API",state="ONLINE"} 1
pulsara_service_uptime_ratio{service="Pulsara Web"} 0.9998
pulsara_service_latency_seconds{service="Pulsara API",quantile="0.95"} 0.024
pulsara_service_last_check_age_seconds{service="Pulsara API"} 3.120
pulsara_incidents_open{severity="CRITICAL",source="AUTOMATED"} 0
pulsara_incidents_open{severity="HIGH",source="AUTOMATED"} 1
pulsara_deployments{status="SUCCESS"} 12
```

### Prometheus Scraper Configuration

Add Pulsara to your `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: 'pulsara'
    scrape_interval: 15s
    static_configs:
      - targets: ['localhost:4000']
    # If METRICS_SCRAPE_TOKEN is configured:
    # authorization:
    #   type: Bearer
    #   credentials: 'your-configured-scrape-token'
```

---

## Testing & Quality Assurance

The codebase includes an extensive testing suite covering pure logic, database transactions, HTTP routes, React components, and end-to-end browser automation.

```bash
# 1. Run backend unit tests (zero infrastructure required):
cd backend
npm run test:unit

# 2. Run backend integration tests (requires PostgreSQL & Redis):
docker compose up -d
npm run test:integration

# 3. Run backend tests with coverage floor enforcement:
npm run test:coverage

# 4. Run frontend tests (Testing Library + jsdom):
cd ../frontend
npm test
npm run test:coverage

# 5. Run end-to-end browser tests with Playwright:
cd ../e2e
npm ci
npm run install:browsers
npm test
```

### Code Quality & Security Audits

```bash
# Type-check TypeScript:
npm run typecheck    # (in backend/ and frontend/)

# Run ESLint:
npm run lint         # (in backend/ and frontend/)

# Format checking:
npm run format:check # (in backend/ and frontend/)

# Dependency security audit gate:
npm run audit        # (in backend/ and frontend/)
```

---

## REST API Reference

All application endpoints are served under the `/api` prefix, with the exception of `/metrics` which is served at the root.

### Common Response Envelope

**Success (2xx):**
```json
{
  "success": true,
  "data": { ... },
  "meta": { ... }
}
```

**Error (4xx / 5xx):**
```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Invalid credentials provided",
    "requestId": "req-98f24bc1"
  }
}
```

### Route Catalog

| Method | Endpoint | Access | Purpose |
| :--- | :--- | :---: | :--- |
| `GET` | `/health` | Public | Liveness check (touches no dependencies). |
| `GET` | `/health/ready` | Public | Readiness probe (verifies database connectivity). |
| `GET` | `/metrics` | Public / Bearer | Standard Prometheus text metrics exposition. |
| **Auth** | | | |
| `POST` | `/api/auth/login` | Public | Email and password sign-in; returns access token + sets refresh cookie. |
| `POST` | `/api/auth/firebase` | Public | Exchanges a verified Firebase Google ID token for a session. |
| `POST` | `/api/auth/refresh` | Cookie | Rotates refresh token cookie and issues a new access token. |
| `POST` | `/api/auth/logout` | Public | Revokes refresh token session and clears session cookies. |
| `GET` | `/api/auth/me` | Authenticated | Fetches profile of the currently logged-in user. |
| `PATCH` | `/api/auth/me` | Authenticated | Updates display name or avatar URL. |
| `POST` | `/api/auth/password` | Authenticated | Changes password and revokes all other active sessions. |
| `GET` | `/api/auth/sessions` | Authenticated | Lists all active refresh sessions for the current account. |
| `DELETE` | `/api/auth/sessions` | Authenticated | Terminates all active sessions (sign out everywhere). |
| **Users & Administration** | | | |
| `GET` | `/api/users` | `ADMIN` | Lists all users with roles and active status. |
| `PATCH` | `/api/users/:id` | `ADMIN` | Changes a user's role or toggles active status. |
| `GET` | `/api/users/audit/log` | `ADMIN` | Retrieves paginated audit trail of privileged operations. |
| **Services & Probing** | | | |
| `GET` | `/api/services` | Authenticated | Returns monitored service catalogue with uptime & p95 latency. |
| `GET` | `/api/services/:id` | Authenticated | Detailed status and recent probe checks for a specific service. |
| `POST` | `/api/services` | `ADMIN` | Registers a new HTTP/HTTPS endpoint to monitor. |
| `PATCH` | `/api/services/:id` | `ADMIN` | Modifies probe interval, URL, or toggles maintenance mode. |
| `DELETE` | `/api/services/:id` | `ADMIN` | Deletes a monitored service and cascades probe history. |
| **Telemetry & Metrics** | | | |
| `GET` | `/api/metrics/series` | Authenticated | Queries downsampled historical host metrics (`from`, `to`, `types`). |
| `GET` | `/api/metrics/latest` | Authenticated | Returns the most recent hardware metrics sample. |
| `GET` | `/api/metrics/hosts` | Authenticated | Lists all host IDs that have reported telemetry. |
| **Deployments (CI/CD)** | | | |
| `GET` | `/api/deployments` | Authenticated | Lists mirrored workflow runs with filters (`status`, `repo`, `branch`). |
| `GET` | `/api/deployments/stats` | Authenticated | Computes deployment success rates and median build durations. |
| `GET` | `/api/deployments/:id` | Authenticated | Returns run details along with individual execution stages. |
| **GitHub Integration** | | | |
| `GET` | `/api/integrations/github/status` | Authenticated | Checks if polling and webhooks are active. |
| `GET` | `/api/integrations/github/connections` | Authenticated | Lists connected GitHub repositories. |
| `POST` | `/api/integrations/github/connections` | `ADMIN` | Connects and triggers backfill for a new repository. |
| `DELETE` | `/api/integrations/github/connections/:id`| `ADMIN` | Disconnects a repository (preserves history). |
| `POST` | `/api/integrations/github/connections/:id/sync` | `ADMIN` | Forces an immediate manual sync with GitHub Actions API. |
| `POST` | `/api/integrations/github/webhook` | Signed Webhook | Ingests signed GitHub `workflow_run` and `workflow_job` events. |
| **Incidents** | | | |
| `GET` | `/api/incidents` | Authenticated | Lists operational incidents with filters (`status`, `severity`, `isOpen`). |
| `GET` | `/api/incidents/summary` | Authenticated | Returns counts of open and resolved incidents by severity. |
| `GET` | `/api/incidents/:id` | Authenticated | Returns incident details with full chronological timeline. |
| `POST` | `/api/incidents` | `MEMBER` | Manually logs a new incident. |
| `PATCH` | `/api/incidents/:id` | `MEMBER` | Updates incident status, severity, or assignee. |
| `POST` | `/api/incidents/:id/comments` | `MEMBER` | Adds an engineer investigation note to the incident timeline. |

---

## Project Directory Structure

```
Pulsara/
├── README.md                      # Comprehensive project documentation
├── ARCHITECTURE.md                # In-depth architectural design decisions
├── RUNBOOK.md                     # Operational troubleshooting and runbook
├── docker-compose.yml             # Container definitions (Postgres, Redis, App)
├── backend/                       # Pulsara Express & WebSocket API
│   ├── prisma/
│   │   ├── schema.prisma          # Database schema and models
│   │   ├── migrations/            # Versioned SQL migrations
│   │   └── seed.ts                # Initial admin & probe target seed script
│   ├── src/
│   │   ├── app.ts                 # Express application configuration
│   │   ├── server.ts              # HTTP & Socket.IO server startup
│   │   ├── config/                # Environment variables & constants
│   │   ├── db/                    # Prisma client singleton
│   │   ├── lib/                   # Errors, logger, and utility libraries
│   │   ├── middleware/            # Auth guard, error handling, rate limiting
│   │   ├── modules/               # Domain modules (auth, telemetry, incidents, etc.)
│   │   └── realtime/              # WebSocket telemetry broadcast emitter
│   ├── tests/                     # Unit and integration test suites
│   ├── package.json
│   └── tsconfig.json
├── frontend/                      # React 19 Single Page Application
│   ├── src/
│   │   ├── App.tsx                # Application shell and routing
│   │   ├── main.tsx               # Entrypoint & DOM mounting
│   │   ├── index.css              # Custom Tailwind theme tokens & glassmorphism
│   │   ├── app/                   # Shell layout, navigation & Sidebar
│   │   ├── features/              # Feature pages (Dashboard, Alerts, Pipelines, etc.)
│   │   └── shared/                # UI components (Button, Card, Drawer, StatusDot)
│   ├── package.json
│   ├── tailwind.config.js
│   └── vite.config.ts
├── e2e/                           # Playwright end-to-end browser test suite
├── infra/                         # Terraform declarations for AWS ECS Fargate
└── scripts/                       # CI audit and utility scripts
```

---

## Troubleshooting & FAQs

### 1. Database Connection Errors (`ECONNREFUSED` on port 5432)
- **Cause**: By default, Docker Compose exposes PostgreSQL on port `5433` to prevent clashing with native PostgreSQL installations running on `5432`.
- **Solution**: Ensure your `DATABASE_URL` in `backend/.env` points to port `5433`:
  ```ini
  DATABASE_URL=postgresql://pulsara:pulsara_local_dev@localhost:5433/pulsara?schema=public
  ```

### 2. Server Refuses to Start (`JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET`)
- **Cause**: The API enforces strict startup validation to ensure secrets are securely configured. Default or placeholder values are rejected.
- **Solution**: Generate two separate 48-byte secrets using OpenSSL:
  ```bash
  openssl rand -base64 48
  ```
  Paste them into `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` in `backend/.env`.

### 3. Services Appear as "Offline" on First Boot
- **Explanation**: The seed script registers three real endpoints: the API itself, the PostgreSQL database, and the web client origin (`http://localhost:5174`). If the frontend is not running yet, the background probe worker will correctly measure it as offline. As soon as you start the frontend dev server, the next probe cycle will automatically detect it and mark it online!

### 4. CORS Errors in the Browser
- **Cause**: The browser origin does not match `CORS_ORIGINS` in `backend/.env`.
- **Solution**: Ensure `CORS_ORIGINS` contains the exact URL your browser is using (e.g., `http://localhost:5174`). Wildcards (`*`) are disallowed because the API uses credentialed sessions.

### 5. Firebase Private Key Formatting Error
- **Cause**: Private keys copied from Google service account JSON files contain escaped newlines (`\n`).
- **Solution**: Wrap the entire key in double quotes in `backend/.env` and preserve the `\n` characters on a single line:
  ```ini
  FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgk...\n-----END PRIVATE KEY-----\n"
  ```

---

## License

This project is licensed under the terms of the [MIT License](LICENSE).
