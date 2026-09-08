# syntax=docker/dockerfile:1

# Pulsara web client image.
#
# The output is static files behind nginx. Vite inlines every `VITE_*` variable
# at build time, so the API origin is a build argument rather than a runtime
# environment variable: an image built for staging cannot be pointed at
# production by changing an env var, and pretending otherwise is how a client
# ends up talking to the wrong API.

ARG NODE_VERSION=22-bookworm-slim


# --- Build ------------------------------------------------------------------
FROM node:${NODE_VERSION} AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Required. The env schema throws at import if it is missing, so a build without
# it produces a bundle that fails on first load — better to fail here.
ARG VITE_API_URL
ENV VITE_API_URL=${VITE_API_URL}

# Optional: Google sign-in is disabled unless all six are supplied.
#
# BuildKit warns that these look like secrets. They are not. A Firebase web API
# key identifies the project to Google's endpoints and is served to every
# visitor inside the bundle no matter how it is supplied; access is controlled
# by Firebase security rules and authorised domains, not by keeping it hidden.
# The service-account private key, which *is* a secret, lives only on the API.
ARG VITE_FIREBASE_API_KEY
ARG VITE_FIREBASE_AUTH_DOMAIN
ARG VITE_FIREBASE_PROJECT_ID
ARG VITE_FIREBASE_APP_ID
ARG VITE_FIREBASE_MESSAGING_SENDER_ID
ARG VITE_FIREBASE_STORAGE_BUCKET
ENV VITE_FIREBASE_API_KEY=${VITE_FIREBASE_API_KEY} \
    VITE_FIREBASE_AUTH_DOMAIN=${VITE_FIREBASE_AUTH_DOMAIN} \
    VITE_FIREBASE_PROJECT_ID=${VITE_FIREBASE_PROJECT_ID} \
    VITE_FIREBASE_APP_ID=${VITE_FIREBASE_APP_ID} \
    VITE_FIREBASE_MESSAGING_SENDER_ID=${VITE_FIREBASE_MESSAGING_SENDER_ID} \
    VITE_FIREBASE_STORAGE_BUCKET=${VITE_FIREBASE_STORAGE_BUCKET}

RUN npm run build


# --- Runtime ----------------------------------------------------------------
# The unprivileged image runs as UID 101 and listens on 8080, which is what
# makes "do not run as root" work without rewriting nginx's pid and temp paths
# by hand.
FROM nginxinc/nginx-unprivileged:1.31-alpine AS runtime

COPY --chown=nginx:nginx nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build --chown=nginx:nginx /app/dist /usr/share/nginx/html

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --spider -q http://127.0.0.1:8080/ || exit 1
