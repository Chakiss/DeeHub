# Multi-stage build for Cloud Run (ADR-0004).
# Built from the repo root: docker build -f apps/api/Dockerfile .

FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm" PATH="/pnpm:$PATH"
RUN corepack enable
WORKDIR /app

# --- dependencies -----------------------------------------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/
COPY packages/shared/package.json ./packages/shared/
RUN pnpm install --frozen-lockfile

# --- build ------------------------------------------------------------------
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY . .
RUN pnpm --filter @deehub/shared build && pnpm --filter @deehub/api build

# Strip dev dependencies before copying into the runtime image.
# --legacy: pnpm 10+ otherwise requires inject-workspace-packages, which would
# duplicate @deehub/shared into every consumer for no benefit here.
RUN pnpm --filter @deehub/api --prod deploy --legacy /app/bundle

# --- runtime ----------------------------------------------------------------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Never run as root.
RUN addgroup -g 1001 -S nodejs && adduser -u 1001 -S deehub -G nodejs

COPY --from=build --chown=deehub:nodejs /app/bundle ./
# Migrations are data, not code: the deploy step runs them before traffic shifts.
COPY --from=build --chown=deehub:nodejs /app/apps/api/src/database/migrations ./dist/database/migrations

USER deehub
EXPOSE 3001

# Cloud Run sends SIGTERM; Nest's shutdown hooks drain the pool.
CMD ["node", "dist/main.js"]
