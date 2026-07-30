#!/usr/bin/env bash
#
# Builds and deploys the real images over the placeholders left by the first
# `terraform apply`, then runs migrations.
#
# CI does this on every push once GitHub secrets are set; this script exists for
# the FIRST deploy, before the pipeline has anything to deploy onto.
set -euo pipefail

ENVIRONMENT="${1:-prod}"
PROJECT="${GCP_PROJECT:-deehub-hotel}"
REGION="${GCP_REGION:-asia-southeast1}"
REGISTRY="${REGION}-docker.pkg.dev/${PROJECT}/deehub-${ENVIRONMENT}"
TAG="$(git rev-parse --short HEAD)"

echo "Deploying ${TAG} to ${ENVIRONMENT}"
gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet

# linux/amd64 explicitly: Cloud Run does not run arm64, and building on an
# Apple Silicon machine would otherwise produce an image that fails to start
# with an exec-format error.
echo "Building API image…"
docker build --platform linux/amd64 -f apps/api/Dockerfile -t "${REGISTRY}/api:${TAG}" .
docker push "${REGISTRY}/api:${TAG}"

echo "Building dashboard image…"
docker build --platform linux/amd64 -f apps/admin-web/Dockerfile -t "${REGISTRY}/web:${TAG}" .
docker push "${REGISTRY}/web:${TAG}"

# Migrations run BEFORE traffic shifts. A failure here stops the deploy with
# production untouched.
echo "Running migrations…"
gcloud run jobs update "deehub-migrate-${ENVIRONMENT}" --region "$REGION" \
  --image "${REGISTRY}/api:${TAG}" --quiet
gcloud run jobs execute "deehub-migrate-${ENVIRONMENT}" --region "$REGION" --wait

echo "Deploying services…"
gcloud run deploy "deehub-api-${ENVIRONMENT}" --region "$REGION" \
  --image "${REGISTRY}/api:${TAG}" --quiet
gcloud run deploy "deehub-web-${ENVIRONMENT}" --region "$REGION" \
  --image "${REGISTRY}/web:${TAG}" --quiet
gcloud run jobs update "deehub-maintenance-${ENVIRONMENT}" --region "$REGION" \
  --image "${REGISTRY}/api:${TAG}" --quiet

API_URL=$(gcloud run services describe "deehub-api-${ENVIRONMENT}" --region "$REGION" --format 'value(status.url)')
WEB_URL=$(gcloud run services describe "deehub-web-${ENVIRONMENT}" --region "$REGION" --format 'value(status.url)')

# No env wiring here on purpose. Terraform already sets DEEHUB_API_URL from the
# api service's own uri attribute, and CORS_ORIGINS stays under var.cors_origins
# — setting either with `gcloud run services update` would drift from state and
# be reverted by the next apply.
#
# The dashboard needs no CORS entry at all: the browser only ever calls the
# Next.js BFF at the same origin, and the BFF reaches the API server-to-server.
# CORS_ORIGINS starts mattering with the public booking engine, which does call
# the API from the browser.

echo "Smoke test…"
# Readiness, not liveness: this proves the revision can reach the database.
curl -fsS --retry 5 --retry-delay 3 "${API_URL}/health/ready"; echo
curl -fsS --retry 5 --retry-delay 3 -o /dev/null "${WEB_URL}/login"

echo
echo "API:       ${API_URL}"
echo "Dashboard: ${WEB_URL}"
