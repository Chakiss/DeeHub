# --- Cloud Run ---------------------------------------------------------------
# Three services from two images (ADR-0004, architecture.md §1). The API and the
# worker share one image and differ only in their command, which guarantees both
# processes run identical domain code.

locals {
  # Shared configuration. Secrets are referenced, never inlined.
  # Empty when channel sync is off: the API treats a missing REDIS_URL as
  # "channels disabled" and refuses to enqueue rather than dropping work.
  redis_url  = var.enable_channel_sync ? "redis://${google_redis_instance.main[0].host}:${google_redis_instance.main[0].port}" : ""
  vpc_egress = "PRIVATE_RANGES_ONLY" # public egress (OTAs) still goes direct

  api_secret_env = {
    DATABASE_URL       = "database-url"
    JWT_ACCESS_SECRET  = "jwt-access-secret"
    JWT_REFRESH_SECRET = "jwt-refresh-secret"
    CREDENTIALS_KEY    = "credentials-key"
    SENTRY_DSN         = "sentry-dsn"
  }
}

resource "google_cloud_run_v2_service" "api" {
  name     = "deehub-api-${local.suffix}"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  deletion_protection = false

  # secret_key_ref names the secret CONTAINER, so Terraform's implicit graph
  # only waits for the container — not for the version holding the value. Cloud
  # Run then refuses to start ("version latest was not found") because a secret
  # with no versions cannot be mounted. Explicit here; the remaining secrets are
  # populated by set-secrets.sh before apply (see README).
  depends_on = [google_secret_manager_secret_version.database_url]

  template {
    service_account = google_service_account.api.email

    scaling {
      # Scale to zero: a small hotel's API is idle most of the night, and Cloud
      # Run bills per request.
      min_instance_count = 0
      max_instance_count = 10
    }

    vpc_access {
      network_interfaces {
        network    = google_compute_network.main.id
        subnetwork = google_compute_subnetwork.main.id
      }
      egress = local.vpc_egress
    }

    containers {
      image = var.api_image

      ports {
        container_port = 3001
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "1Gi"
        }
        # CPU is only allocated while a request is in flight, which is the
        # cheaper mode and correct for a request/response service.
        cpu_idle = true
      }

      env {
        name  = "NODE_ENV"
        value = "production"
      }
      # PORT is deliberately NOT set: Cloud Run injects it from
      # container_port above and rejects the deploy if it is provided
      # explicitly ("reserved env names were provided").
      env {
        name  = "REDIS_URL"
        value = local.redis_url
      }
      env {
        name  = "CORS_ORIGINS"
        value = var.cors_origins
      }
      env {
        name  = "STORAGE_BUCKET"
        value = google_storage_bucket.media.name
      }

      dynamic "env" {
        for_each = local.api_secret_env
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.api[env.value].secret_id
              version = "latest"
            }
          }
        }
      }

      startup_probe {
        # Liveness only — it must not touch the database, or a brief Cloud SQL
        # blip would make Cloud Run kill every healthy instance.
        http_get {
          path = "/health"
          port = 3001
        }
        initial_delay_seconds = 5
        period_seconds        = 5
        failure_threshold     = 6
      }

      liveness_probe {
        http_get {
          path = "/health"
          port = 3001
        }
        period_seconds = 30
      }
    }
  }

  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }
}

resource "google_cloud_run_v2_service" "worker" {
  # See var.enable_channel_sync. Without channels there is nothing to consume,
  # and an always-on instance is the most expensive line in the stack; the
  # maintenance job below covers the housekeeping instead.
  count = var.enable_channel_sync ? 1 : 0

  name     = "deehub-worker-${local.suffix}"
  location = var.region

  # See the api service: the secret version is not an implicit dependency.
  depends_on = [google_secret_manager_secret_version.database_url]

  # No public traffic: the worker is driven by Redis, not by HTTP.
  ingress = "INGRESS_TRAFFIC_INTERNAL_ONLY"

  deletion_protection = false

  template {
    service_account = google_service_account.worker.email

    scaling {
      # min_instance_count = 1 is REQUIRED, not an optimisation: the worker
      # polls Redis and drains the outbox. At zero instances no booking would
      # ever reach an OTA, silently.
      min_instance_count = 1
      max_instance_count = 3
    }

    vpc_access {
      network_interfaces {
        network    = google_compute_network.main.id
        subnetwork = google_compute_subnetwork.main.id
      }
      egress = local.vpc_egress
    }

    containers {
      image   = var.api_image
      command = ["node"]
      args    = ["dist/worker.js"]

      resources {
        limits = {
          cpu    = var.worker_cpu
          memory = var.worker_memory
        }
        # The worker runs between requests, so it needs CPU always allocated —
        # with cpu_idle the relay loop would be throttled to a crawl. It is also
        # why this service is billed for every second of the month.
        cpu_idle = false
      }

      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "REDIS_URL"
        value = local.redis_url
      }

      dynamic "env" {
        for_each = local.api_secret_env
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.api[env.value].secret_id
              version = "latest"
            }
          }
        }
      }
    }
  }
}

resource "google_cloud_run_v2_service" "web" {
  name     = "deehub-web-${local.suffix}"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  deletion_protection = false

  template {
    service_account = google_service_account.web.email

    scaling {
      min_instance_count = 0
      max_instance_count = 10
    }

    containers {
      image = var.web_image

      ports {
        container_port = 3000
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle = true
      }

      env {
        name  = "NODE_ENV"
        value = "production"
      }
      # Server-to-server over the public URL. The dashboard holds no database
      # credentials at all — it is a backend-for-frontend over the API.
      env {
        name  = "DEEHUB_API_URL"
        value = "${google_cloud_run_v2_service.api.uri}/api/v1"
      }

      startup_probe {
        http_get {
          path = "/login"
          port = 3000
        }
        initial_delay_seconds = 5
        period_seconds        = 5
        failure_threshold     = 6
      }
    }
  }

  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }
}

# --- Migrations --------------------------------------------------------------
# A Cloud Run JOB, executed by CI BEFORE the services are updated. Running
# migrations from an application container at boot would race across instances
# and could half-apply a schema while old code is still serving.

resource "google_cloud_run_v2_job" "migrate" {
  name     = "deehub-migrate-${local.suffix}"
  location = var.region

  deletion_protection = false

  # See the api service: the secret version is not an implicit dependency.
  depends_on = [google_secret_manager_secret_version.database_url]

  template {
    template {
      service_account = google_service_account.api.email
      max_retries     = 0 # a failed migration must stop the deploy, not retry

      vpc_access {
        network_interfaces {
          network    = google_compute_network.main.id
          subnetwork = google_compute_subnetwork.main.id
        }
        egress = local.vpc_egress
      }

      containers {
        image   = var.api_image
        command = ["node"]
        args    = ["dist/database/migrate.js"]

        env {
          name  = "NODE_ENV"
          value = "production"
        }

        dynamic "env" {
          for_each = {
            DATABASE_URL       = "database-url"
            JWT_ACCESS_SECRET  = "jwt-access-secret"
            JWT_REFRESH_SECRET = "jwt-refresh-secret"
            CREDENTIALS_KEY    = "credentials-key"
          }
          content {
            name = env.key
            value_source {
              secret_key_ref {
                secret  = google_secret_manager_secret.api[env.value].secret_id
                version = "latest"
              }
            }
          }
        }
      }
    }
  }
}

# --- Public access -----------------------------------------------------------
# Both HTTP services are reachable without IAM: the API authenticates with JWTs
# and the dashboard has its own login. OTA webhooks could not present a Google
# identity token in any case.

resource "google_cloud_run_v2_service_iam_member" "api_public" {
  name     = google_cloud_run_v2_service.api.name
  location = google_cloud_run_v2_service.api.location
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_cloud_run_v2_service_iam_member" "web_public" {
  name     = google_cloud_run_v2_service.web.name
  location = google_cloud_run_v2_service.web.location
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# --- Scheduled maintenance ----------------------------------------------------
# Drains the outbox, expires lapsed holds and reconciles inventory, then exits.
#
# This runs in BOTH modes. With channels connected the worker handles the queues
# with sub-minute latency and this is a safety net; without them it is the only
# thing keeping the outbox drained and, more importantly, running the inventory
# drift check — the alarm for booking-path bugs.

resource "google_cloud_run_v2_job" "maintenance" {
  name     = "deehub-maintenance-${local.suffix}"
  location = var.region

  deletion_protection = false

  # See the api service: the secret version is not an implicit dependency.
  depends_on = [google_secret_manager_secret_version.database_url]

  template {
    template {
      service_account = google_service_account.worker.email
      # One attempt: a genuine failure should surface, not be masked by a retry
      # that happens to succeed.
      max_retries = 0
      timeout     = "600s"

      vpc_access {
        network_interfaces {
          network    = google_compute_network.main.id
          subnetwork = google_compute_subnetwork.main.id
        }
        egress = local.vpc_egress
      }

      containers {
        image   = var.api_image
        command = ["node"]
        args    = ["dist/maintenance.js"]

        resources {
          limits = {
            cpu    = "1"
            memory = "512Mi"
          }
        }

        env {
          name  = "NODE_ENV"
          value = "production"
        }
        env {
          name  = "REDIS_URL"
          value = local.redis_url
        }

        dynamic "env" {
          for_each = local.api_secret_env
          content {
            name = env.key
            value_source {
              secret_key_ref {
                secret  = google_secret_manager_secret.api[env.value].secret_id
                version = "latest"
              }
            }
          }
        }
      }
    }
  }
}

resource "google_service_account" "scheduler" {
  account_id   = "deehub-scheduler-${local.suffix}"
  display_name = "DeeHub maintenance scheduler"
}

resource "google_cloud_run_v2_job_iam_member" "scheduler_runs_maintenance" {
  name     = google_cloud_run_v2_job.maintenance.name
  location = google_cloud_run_v2_job.maintenance.location
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler.email}"
}

resource "google_cloud_scheduler_job" "maintenance" {
  name      = "deehub-maintenance-${local.suffix}"
  region    = var.region
  schedule  = var.maintenance_schedule
  time_zone = "Asia/Bangkok"

  # A missed run is not worth retrying: the next tick does the same work.
  retry_config {
    retry_count = 0
  }

  http_target {
    http_method = "POST"
    uri = format(
      "https://%s-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/%s/jobs/%s:run",
      var.region, var.project_id, google_cloud_run_v2_job.maintenance.name,
    )
    oauth_token {
      service_account_email = google_service_account.scheduler.email
    }
  }

  depends_on = [google_project_service.enabled]
}
