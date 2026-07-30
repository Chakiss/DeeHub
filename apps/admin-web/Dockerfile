# Multi-stage build for Cloud Run (ADR-0004).
# Built from the repo root: docker build -f apps/admin-web/Dockerfile .

FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm" PATH="/pnpm:$PATH"
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/admin-web/package.json ./apps/admin-web/
COPY packages/shared/package.json ./packages/shared/
RUN pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/admin-web/node_modules ./apps/admin-web/node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY . .
RUN pnpm --filter @deehub/shared build && pnpm --filter @deehub/admin-web build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app

RUN addgroup -g 1001 -S nodejs && adduser -u 1001 -S deehub -G nodejs

# `output: standalone` emits the server and its traced dependencies but NOT the
# static assets or public files — they must be copied in explicitly. Miss this
# and the app serves HTML with every script and stylesheet 404ing, which looks
# like a blank page with no error anywhere.
COPY --from=build --chown=deehub:nodejs /app/apps/admin-web/.next/standalone ./
COPY --from=build --chown=deehub:nodejs /app/apps/admin-web/.next/static ./apps/admin-web/.next/static

USER deehub
EXPOSE 3000

CMD ["node", "apps/admin-web/server.js"]
