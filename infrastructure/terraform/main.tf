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
}

resource "google_storage_bucket_iam_member" "api_media" {
  bucket = google_storage_bucket.media.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.api.email}"
}
