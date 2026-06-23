# TatvaCare backend Dockerfile (production).
#
# Two-stage build:
#   - deps  : install only production deps into node_modules, then COPY
#             them into the runtime image. Keeps the runtime image small
#             and avoids carrying the npm cache / dev tooling.
#   - run   : node:20-alpine. Runs as non-root. Includes curl for healthz.
#
# Build:    docker build -t tatvacare-backend -f backend/Dockerfile .
# Run:      docker run --rm -p 3000:3000 \
#             -e NODE_ENV=production \
#             -e AI_SERVICE_KEY=changeme \
#             -e SESSION_COOKIE_SECRET=changeme \
#             -e VBP_HOST=host.docker.internal \
#             tatvacare-backend
FROM node:20-alpine AS deps
WORKDIR /app
COPY backend/package.json backend/package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:20-alpine AS run
# curl is used by the HEALTHCHECK below. tini gives us a proper signal
# handler so SIGTERM (from docker stop / k8s) reaches the Node process
# instead of being absorbed by alpine's sh.
RUN apk add --no-cache curl tini
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY backend/ ./
# Public dir served as static. Lives one level up; we copy it explicitly so
# the runtime image doesn't need the whole repo.
COPY public/ ./public/

# Run as non-root for least-privilege. node:20-alpine ships with a `node` user.
USER node

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

EXPOSE 3000

# Use tini so PID 1 forwards SIGTERM to the Node process. Without this,
# `docker stop` sends SIGTERM to tini (PID 1) which doesn't propagate —
# Node only sees SIGKILL after the 10s grace and never gets to drain.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.mjs"]

# Two-tier health check:
#   - --start-period=20s covers model-load + Vedadb ping + first VBP connect.
#   - --interval=15s with --timeout=3s is well under our 30s AI fetch timeout.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/api/health || exit 1
