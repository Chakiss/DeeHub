# ADR-0004: Google Cloud infrastructure

- **Status:** Accepted
- **Date:** 2026-07-29
- **Decider:** Founder

## Context

The master prompt specifies Docker + GitHub Actions + Cloud Run, implying
Google Cloud. Alternatives considered: budget PaaS (Railway/Render/Fly.io)
and AWS.

## Decision

Commit to Google Cloud:

| Concern     | Service                                                                                         |
| ----------- | ----------------------------------------------------------------------------------------------- |
| API + Web   | Cloud Run (scale-to-zero containers)                                                            |
| Worker      | Cloud Run (always-on min instance for BullMQ)                                                   |
| Database    | Cloud SQL for PostgreSQL                                                                        |
| Cache/Queue | Memorystore for Redis                                                                           |
| Storage     | Google Cloud Storage (S3-compatible access via interop mode; code uses an S3-compatible client) |
| Secrets     | Secret Manager                                                                                  |
| CI/CD       | GitHub Actions → Artifact Registry → Cloud Run                                                  |
| Monitoring  | Sentry + Cloud Logging                                                                          |

Local development runs entirely on **Docker Compose** (Postgres, Redis,
MinIO) — no cloud dependency to develop.

## Consequences

- Minimal ops burden for a 3-person team; managed everything.
- Cloud SQL + Memorystore are the main fixed costs (~$50–80/month for
  smallest HA-less tiers); acceptable, and dev/staging can share instances.
- Storage code targets the S3 API (via GCS interop / MinIO locally), so a
  future move off GCS is a config change.
- BullMQ workers need a non-scale-to-zero Cloud Run service (min instances
  = 1) since they poll Redis.
