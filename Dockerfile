# Next.js standalone build on node:24-alpine, pnpm, non-root.
#
# This build assumes a Next.js (App Router) repo with `output: "standalone"` set in next.config.
# Without that setting, `.next/standalone` never gets produced and the runtime stage below has
# nothing to copy.
#
# The base image is a build argument so a registry mirror can be used:
#   docker build --build-arg BASE_IMAGE=registry.example.com/node:24-alpine .
# Dependencies install at build time only; the running container needs no registry access.

ARG BASE_IMAGE=node:24-alpine
FROM ${BASE_IMAGE} AS base
# corepack enable gives every stage `pnpm` without installing it separately. If a future
# base image ships a corepack that refuses to activate pnpm (signature/registry issues),
# fall back to `npm install -g pnpm` here instead — do not silently drop to npm/yarn.
RUN corepack enable

# ---- deps: install with full lockfile, cached separately from source ----
FROM base AS deps
WORKDIR /app
# Globs: a freshly bootstrapped repo has no lockfile/workspace file yet; pnpm 10+
# needs pnpm-workspace.yaml when it declares onlyBuiltDependencies (e.g. esbuild).
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml* ./
RUN pnpm install --frozen-lockfile

# ---- build: compile the Next.js app (requires output: "standalone" in next.config) ----
FROM base AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Guarantee a public/ dir exists even if this repo doesn't ship one (a headless/API-only
# Next.js app, or an existing app migrated without static assets) — the runtime stage
# below copies it unconditionally, and a missing source dir fails that COPY outright.
RUN mkdir -p public
RUN pnpm run build

# ---- runtime: the standalone bundle only, non-root, no registry egress ----
FROM base AS runtime
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app

# Next.js standalone output already vendors its own production node_modules subset —
# nothing here re-runs `pnpm install`.
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --from=build --chown=app:app /app/public ./public

RUN mkdir -p /data && chown app:app /data
USER app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV DATA_DIR=/data
VOLUME /data
EXPOSE 3000

# Bare /healthz, not /api/healthz: matches the app/healthz/route.ts handler
# and README.md require, and what container readiness/liveness probes expect.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "server.js"]
