# Multi-stage build for Cloud Run (ADR-0004).
# Built from the repo root: docker build -f apps/booking-web/Dockerfile .

FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm" PATH="/pnpm:$PATH"
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/booking-web/package.json ./apps/booking-web/
COPY packages/shared/package.json ./packages/shared/
RUN pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/booking-web/node_modules ./apps/booking-web/node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY . .
RUN pnpm --filter @deehub/shared build && pnpm --filter @deehub/booking-web build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app

RUN addgroup -g 1001 -S nodejs && adduser -u 1001 -S deehub -G nodejs

# `output: standalone` emits the server and its traced dependencies but NOT the
# static assets or public files — they must be copied in explicitly (the same
# trap the dashboard's Dockerfile documents).
COPY --from=build --chown=deehub:nodejs /app/apps/booking-web/.next/standalone ./
COPY --from=build --chown=deehub:nodejs /app/apps/booking-web/.next/static ./apps/booking-web/.next/static
COPY --from=build --chown=deehub:nodejs /app/apps/booking-web/public ./apps/booking-web/public

USER deehub
EXPOSE 3000

CMD ["node", "apps/booking-web/server.js"]
