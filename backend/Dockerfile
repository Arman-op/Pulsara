# syntax=docker/dockerfile:1

# Pulsara API image.
#
# Three stages, so the thing that ships contains neither the toolchain nor the
# source. The build stage needs devDependencies and a compiler; the runtime
# stage needs neither, and every tool left in a production image is a tool an
# attacker inherits.
#
# Debian slim rather than Alpine: Prisma's query engine and the argon2 native
# module both link against OpenSSL, and musl builds of those are the usual
# source of an image that builds cleanly and then fails to start.

ARG NODE_VERSION=22-bookworm-slim


# --- Dependencies -----------------------------------------------------------
# Isolated so that a source-only change reuses this layer instead of
# reinstalling the dependency tree.
FROM node:${NODE_VERSION} AS deps
WORKDIR /app

COPY package.json package-lock.json ./
# `npm ci` installs exactly the lockfile, which is the point of committing one.
RUN npm ci


# --- Build ------------------------------------------------------------------
FROM node:${NODE_VERSION} AS build
WORKDIR /app

# Prisma picks its query engine by detecting the OpenSSL version present at
# generation time. `node:*-slim` ships without the openssl binary, so detection
# silently falls back to debian-openssl-1.1.x and produces a client that cannot
# start on the 3.0 runtime below — a failure that only appears when the
# container is run, not when it is built.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Generates the Prisma client, then compiles to dist/.
RUN npm run build

# Reinstall without devDependencies, so the runtime stage copies a tree that
# contains only what production needs — and re-generate, because pruning removes
# the client that `npm run build` produced.
RUN npm ci --omit=dev && npx prisma generate


# --- Runtime ----------------------------------------------------------------
FROM node:${NODE_VERSION} AS runtime
WORKDIR /app

ENV NODE_ENV=production
# Signals reach PID 1 directly, so the graceful shutdown in server.ts actually
# runs on `docker stop` instead of the container being killed after the grace
# period.
ENV PORT=4000

# OpenSSL is a runtime requirement of the Prisma query engine, not just a build
# one. `node:*-slim` does not include it.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
# Migrations and schema ship with the image so a release can apply them itself,
# rather than depending on a checkout being present wherever it is deployed.
COPY --from=build /app/prisma ./prisma

# The `node` user exists in the official image already. Running as root would
# mean a remote-code-execution bug in a dependency owns the container.
USER node

EXPOSE 4000

# Liveness only. Readiness touches the database, and a database blip must not
# make the orchestrator restart every replica during a failover.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
