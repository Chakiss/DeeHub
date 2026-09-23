terraform {
  required_version = ">= 1.9"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
  # State must be remote: a local state file means one laptop can destroy
  # production and nobody else can deploy.
  backend "gcs" {}
}

provider "google" {
  project = var.project_id
  region  = var.region
}

locals {
  suffix = var.environment

  services = [
    "run.googleapis.com",
    "sqladmin.googleapis.com",
    "redis.googleapis.com",
    "secretmanager.googleapis.com",
    "artifactregistry.googleapis.com",
    "servicenetworking.googleapis.com",
    "vpcaccess.googleapis.com",
    "cloudscheduler.googleapis.com",
    "monitoring.googleapis.com",
    "clouderrorreporting.googleapis.com",
    # Both were already on in this project — the VPC needed compute long before
    # the load balancer did — so declaring them changes nothing here. They are
    # listed because a fresh project would fail the apply without them, and the
    # error names a permission rather than a missing API.
    "compute.googleapis.com",
    "storage.googleapis.com",
  ]
}

resource "google_project_service" "enabled" {
  for_each = toset(local.services)
  service  = each.value
  # Leave APIs enabled if the stack is torn down; disabling them can break
  # unrelated resources in the same project.
  disable_on_destroy = false
}

resource "google_artifact_registry_repository" "images" {
  location      = var.region
  repository_id = "deehub-${local.suffix}"
  format        = "DOCKER"
  description   = "DeeHub container images"

  docker_config {
    immutable_tags = true
  }

  depends_on = [google_project_service.enabled]
}

# --- Service accounts --------------------------------------------------------
# One per workload, so a compromised dashboard cannot read the database secret
# and the worker cannot serve traffic.

resource "google_service_account" "api" {
  account_id   = "deehub-api-${local.suffix}"
  display_name = "DeeHub API"
}

resource "google_service_account" "worker" {
  account_id   = "deehub-worker-${local.suffix}"
  display_name = "DeeHub worker"
}

resource "google_service_account" "web" {
  account_id   = "deehub-web-${local.suffix}"
  display_name = "DeeHub dashboard"
}

# --- Secrets -----------------------------------------------------------------
# Terraform creates the containers; the VALUES are added out of band so they
# never appear in state, in a plan, or in a pull request.

locals {
  api_secrets = [
    "jwt-access-secret",
    "jwt-refresh-secret",
    "credentials-key",
    "database-url",
    "sentry-dsn",
    "email-api-key",
    "line-channel-token",
    # HMAC pair for signed photo uploads (google_storage_hmac_key.api).
    "storage-access-key",
    "storage-secret-key",
  ]
}

resource "google_secret_manager_secret" "api" {
  for_each  = toset(local.api_secrets)
  secret_id = "deehub-${each.value}-${local.suffix}"

  replication {
    auto {}
  }

  depends_on = [google_project_service.enabled]
}

resource "google_secret_manager_secret_iam_member" "api_access" {
  for_each  = google_secret_manager_secret.api
  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.api.email}"
}

resource "google_secret_manager_secret_iam_member" "worker_access" {
  for_each  = google_secret_manager_secret.api
  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.worker.email}"
}

# --- Storage -----------------------------------------------------------------

resource "google_storage_bucket" "media" {
  name                        = "${var.project_id}-deehub-media-${local.suffix}"
  location                    = var.region
  uniform_bucket_level_access = true
  # Room photos are referenced by reservations and listings; versioning makes an
  # accidental overwrite recoverable.
  versioning {
    enabled = true
  }

  # The dashboard PUTs photos here straight from the browser on a URL the API
  # signed, so the bucket must answer the preflight for the dashboard's
  # origins. Reads need no CORS: an <img> is not a fetch.
  cors {
    origin          = split(",", var.cors_origins)
    method          = ["PUT", "GET", "HEAD"]
    response_header = ["Content-Type", "Content-Length", "ETag"]
    max_age_seconds = 3600
  }
}

resource "google_storage_bucket_iam_member" "api_media" {
  bucket = google_storage_bucket.media.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.api.email}"
}

# Photos are read straight from the bucket by every guest's browser and by
# Google's crawler, so the bucket is world-readable. Nothing but photos lives
# here — the API writes only under `public/{org}/{property}/` and the key is
# minted server-side — and the bucket name is not a secret.
resource "google_storage_bucket_iam_member" "media_public" {
  bucket = google_storage_bucket.media.name
  role   = "roles/storage.objectViewer"
  member = "allUsers"
}

# The API signs uploads with the S3 protocol (one adapter for MinIO locally
# and GCS in production), which means an HMAC key for the API's own service
# account rather than its OAuth identity. The secret half is written to Secret
# Manager by set-secrets.sh from `terraform output -raw storage_hmac_secret`;
# it is sensitive in state, never printed by a plan.
resource "google_storage_hmac_key" "api" {
  service_account_email = google_service_account.api.email
}
