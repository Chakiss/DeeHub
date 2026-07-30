# --- Cloud Run ---------------------------------------------------------------
# Three services from two images (ADR-0004, architecture.md §1). The API and the
# worker share one image and differ only in their command, which guarantees both
# processes run identical domain code.

locals {
  # Shared configuration. Secrets are referenced, never inlined.
  redis_url  = "redis://${google_redis_instance.main.host}:${google_redis_instance.main.port}"
  vpc_egress = "PRIVATE_RANGES_ONLY" # public egress (OTAs) still goes direct
}

resource "google_cloud_run_v2_service" "api" {
  name     = "deehub-api-${local.suffix}"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  deletion_protection = false

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
      env {
        name  = "PORT"
        value = "3001"
      }
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
        for_each = {
          DATABASE_URL       = "database-url"
          JWT_ACCESS_SECRET  = "jwt-access-secret"
          JWT_REFRESH_SECRET = "jwt-refresh-secret"
          CREDENTIALS_KEY    = "credentials-key"
          SENTRY_DSN         = "sentry-dsn"
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
  name     = "deehub-worker-${local.suffix}"
  location = var.region
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
          cpu    = "1"
          memory = "1Gi"
        }
        # The worker runs between requests, so it needs CPU always allocated —
        # with cpu_idle the relay loop would be throttled to a crawl.
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
        for_each = {
          DATABASE_URL       = "database-url"
          JWT_ACCESS_SECRET  = "jwt-access-secret"
          JWT_REFRESH_SECRET = "jwt-refresh-secret"
          CREDENTIALS_KEY    = "credentials-key"
          SENTRY_DSN         = "sentry-dsn"
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
