# Real-Time DevOps Dashboard 🚀

# Pulsara: Real-Time DevOps & Infrastructure Dashboard 🚀

A startup-ready, production-grade web application for engineering teams to monitor CI/CD pipelines, container health, deployment statuses, live metrics, and team activity in one unified, real-time interface.
Pulsara is a production-grade, startup-ready DevOps monitoring system. It consolidates real-time host metrics, active CI/CD deployment pipelines, system health states, and alerts/incidents into a single dark-themed glassmorphic interface.

## 🌟 Features

The application leverages a hybrid architecture combining a local Node.js + Express + Prisma (SQLite) stack with Firebase Google OAuth for client authentication, achieving a highly secure, offline-first local experience.

- **Real-Time Metrics:** Live updates for CPU, memory, and network usage with sparkline graphs and dynamic deltas.
- **Glassmorphism UI:** Built with Tailwind CSS ensuring dark-mode best practices, satisfying the "clear under pressure" philosophy.
- **CI/CD Feed:** Live pipeline monitoring with simulated status rings and step-level pills.
- **Alerts & Incidents Feed:** See immediate, color-coded P1/P2/P3 severity alerts.
- **Role-Based Auth (JWT):** Express backend serving secure, HttpOnly refresh tokens.
- **WebSockets:** Powered by Socket.io for instantaneous dashboard pushes (no polling).

---

## 📊 Architecture

## 🌟 Key Capabilities & Features

- **Google OAuth Login (Firebase client SDK):** Replaced legacy email/password authentication with a secure Google Sign-In popup mechanism.
- **Backend Handshake & Provisioning:** The Express server validates the Google ID token via `firebase-admin`. If the user is logging in for the first time, they are automatically provisioned in the local database.
- **Dynamic Session Management:** Real-time user states display names, emails, and avatars sourced directly from Google. Includes a logout feature that cleanly invalidates sessions on both Firebase and the backend server.
- **Live Infrastructure Metrics:** Dynamic telemetry for host nodes (CPU, memory, network, and disk) streamed instantly using **Socket.io**.
- **Real-Time Pipeline Statuses:** An active feed simulating CI/CD pipeline runs with stage-by-stage pill indicators (`Build`, `Test`, `Deploy`) and live logs.
- **Microservices Health Grid:** Real-time visibility into microservices states (`ONLINE`, `DEGRADED`, `OFFLINE`) with response times and uptime indicators.
- **Incident & Alerts Management:** Immediate incident response listing categorized by P1 Critical to P3 Medium severity with assignees and status flags.

---

## 📊 System Architecture & Data Flow

```mermaid
graph TD
    A[Client UI - React 18, Zustand, Recharts] -->|HTTPS/WSS| B(Nginx Reverse Proxy)
    B -->|REST API| C(Express.js Backend API)
    B -->|WebSockets| D(Socket.io Server)
    C <--> E[(PostgreSQL - Prisma)]
    C <--> F[(Redis Cache / Sessions)]
    D <--> F
sequenceDiagram
    autonumber
    actor User as DevOps Operator
    participant FE as React Client (Zustand + Socket.io)
    participant FB as Firebase OAuth API
    participant BE as Express Backend (tsx)
    database DB as SQLite Database (Prisma)
    User->>FE: Clicks "Sign in with Google"
    FE->>FB: Open Auth Popup & Authenticate
    FB-->>FE: Return Firebase idToken
    FE->>BE: POST /api/auth/firebase { idToken }
    BE->>FB: Validate idToken (firebase-admin)
    FB-->>BE: Decoded Payload (email, name, picture)
    BE->>DB: Check if user exists (prisma.user.findUnique)
    alt User is new
        BE->>DB: Auto-provision User (role: ADMIN)
    end
    BE-->>FE: Return local JWT access/refresh token & user payload
    FE->>BE: Connect via WebSockets & request dashboard statistics
    BE->>FE: Pushes live system metrics & simulator events
```

### Technical Stack Details

- **Frontend:** React 19, Vite, Zustand (Auth state persistence), Tailwind CSS (Glassmorphism layout), Recharts (Live telemetry graphs), Lucide icons.
- **Backend:** Express, Node.js v20+, TypeScript (via `tsx` engine), Socket.io (WebSocket event stream), Winston (Structured Logging).
- **Database:** SQLite managed via Prisma Client (allowing rapid offline testing without Docker requirements).

---

## 🛠️ Prerequisites

- **Node.js**: v20+
- **Docker** & **Docker Compose**
- **npm** or **yarn**
- **Node.js**: v20 or higher
- **npm** or **yarn** package manager

---

## 🚀 Setup & Installation

### Option 1: Docker (Recommended)

Follow these steps to configure and boot both the backend and frontend services locally.

1. Clone the repo.
2. Ensure Docker daemon is running.
3. Run:

   ```bash
   docker-compose up --build -d
   ```

4. Access the UI at `http://localhost:80` and the API at `http://localhost:4000`.

### 1. Database & Backend Setup

### Option 2: Manual Local Setup

Navigate to the `backend` directory:

```bash
cd backend
```

**1. Database Setup**
Start PostgreSQL locally or use Docker to just run the DB:
Install the backend dependencies:

```bash
docker-compose up -d db redis
npm install
```

**2. Backend**
Configure your environment variables. Copy the `.env.example` file:

```bash
cd backend
npm install
cp .env.example .env # (Ensure DATABASE_URL is set)
cp .env.example .env
```

*(No need to configure postgres, as the project was migrated to SQLite for a lightweight, setup-free experience).*
Verify your Prisma Schema and generate/migrate database models:

```bash
npx prisma generate
npx prisma db push
```

(Optional) Populate mock services, pipelines, and incidents:

```bash
npx prisma db seed
```

Start the backend server:

```bash
npm run dev
```

The server will boot on `http://localhost:4000`.
**3. Frontend**
---

### 2. Frontend Setup

In a new terminal window, navigate to the `frontend` directory:

```bash
cd frontend
```

Install the frontend dependencies:

```bash
npm install
```

Start the frontend development server:

```bash
npm run dev
```

Access the frontend at `http://localhost:5173`.
The client dashboard will boot on `http://localhost:5173`.

## 🔐 Environment Variables

---

### Backend (`backend/.env`)

|
 Variable
|
 Description
|
 Example
|
|
----------

|
-------------

|
---------

|
|
`PORT`
|
 API Port
|
`4000`
|
|
`DATABASE_URL`
|
 Postgres connection string
|
`postgresql://user:pass@localhost:5432/db`
|
|
`JWT_SECRET`
|
 Secret for access tokens
|
`your_jwt_secret`
|
|
`REFRESH_SECRET`
|
 Secret for refresh tokens
|
`your_refresh_secret`
|
|
`CORS_ORIGIN`
|
 Allowed UI origins
|
`http://localhost:5173`
|

## 🔐 Configuration

### Frontend (`frontend/.env`)

|
 Variable
|
 Description
|
 Example
|
|
----------

|
-------------

|
---------

|
|
`VITE_API_URL`
|
 Backend URL for API & Sockets
|
`http://localhost:4000`
|

### Backend Env (`backend/.env`)

|
 Variable
|
 Description
|
 Default
|
|
---

|
---

|
---

|
|
`PORT`
|
 Node server listening port
|
`4000`
|
|
`DATABASE_URL`
|
 Prisma DB location
|
`file:./dev.db`
|
|
`JWT_SECRET`
|
 Secret token signing key
|
`your_jwt_secret`
|
|
`REFRESH_SECRET`
|
 Secret token refresh key
|
`your_refresh_secret`
|
|
`CORS_ORIGIN`
|
 Allowed Client Origin URL
|
`http://localhost:5173`
|

## 🕹️ Demo Credentials

*Note: Firebase SDK credentials inside the frontend (`frontend/src/shared/utils/firebase.ts`) are pre-configured to point to the `pulsara-devops-dash` cloud instance. No additional frontend `.env` config is required for immediate local execution.*
To bypass the DB setup initially and easily test the UI, use the mock user built into the controller:

- **Email:** `admin@pulsara.dev`
- **Password:** `password`

---

## 🧪 Testing

Both backend and frontend feature unit and integration tests. Run the test suites via:

```bash
# Backend
# Test backend routes & validation
cd backend && npm run test
# Frontend
# Test frontend react components
cd frontend && npm run test
```

*Continuous Integration runs automatically via GitHub Actions.*

## 🤝 Contributing

Please see `CONTRIBUTING.md` for guidelines on branching strategies and PR templates
---

*Built with React, Node.js, Socket.io, TailwindCSS, Framer Motion, and Prisma.*
