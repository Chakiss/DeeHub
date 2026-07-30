# --- Network -----------------------------------------------------------------
# Cloud SQL and Memorystore both sit on a private network. Cloud Run reaches
# them with Direct VPC egress, which replaced the old Serverless VPC Access
# connector and removes a whole managed component from the stack.

resource "google_compute_network" "main" {
  name                    = "deehub-${local.suffix}"
  auto_create_subnetworks = false
  depends_on              = [google_project_service.enabled]
}

resource "google_compute_subnetwork" "main" {
  name          = "deehub-${local.suffix}"
  network       = google_compute_network.main.id
  region        = var.region
  ip_cidr_range = "10.20.0.0/20"
  # Cloud Run instances draw addresses from this range.
  private_ip_google_access = true
}

resource "google_compute_global_address" "private_ip" {
  name          = "deehub-private-ip-${local.suffix}"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = google_compute_network.main.id
}

resource "google_service_networking_connection" "private_vpc" {
  network                 = google_compute_network.main.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_ip.name]
  depends_on              = [google_project_service.enabled]
}

# --- PostgreSQL --------------------------------------------------------------

resource "google_sql_database_instance" "main" {
  name             = "deehub-${local.suffix}"
  database_version = "POSTGRES_17"
  region           = var.region

  # Protects against `terraform destroy` taking the reservations with it.
  deletion_protection = true

  settings {
    tier              = var.db_tier
    availability_type = "ZONAL"
    disk_size         = var.db_disk_gb
    disk_autoresize   = true

    backup_configuration {
      enabled = true
      # Point-in-time recovery is the difference between losing a day of
      # bookings and losing none (docs/database.md §13).
      point_in_time_recovery_enabled = true
      start_time                     = "18:00" # 01:00 Asia/Bangkok
      backup_retention_settings {
        retained_backups = 14
      }
    }

    ip_configuration {
      # No public IP: the database is reachable only from the VPC.
      ipv4_enabled    = false
      private_network = google_compute_network.main.id
    }

    database_flags {
      # Surfaces the slow queries behind a sluggish inventory grid.
      name  = "log_min_duration_statement"
      value = "500"
    }

    insights_config {
      query_insights_enabled = true
    }
  }

  depends_on = [google_service_networking_connection.private_vpc]
}

resource "google_sql_database" "main" {
  name     = "deehub"
  instance = google_sql_database_instance.main.name
}

# The password is generated here and written to Secret Manager, so it never
# passes through a human or a chat window.
resource "random_password" "db" {
  length  = 32
  special = false
}

resource "google_sql_user" "app" {
  name     = "deehub"
  instance = google_sql_database_instance.main.name
  password = random_password.db.result
}

resource "google_secret_manager_secret_version" "database_url" {
  secret = google_secret_manager_secret.api["database-url"].id
  secret_data = format(
    "postgresql://%s:%s@%s:5432/%s",
    google_sql_user.app.name,
    random_password.db.result,
    google_sql_database_instance.main.private_ip_address,
    google_sql_database.main.name,
  )
}

# --- Redis -------------------------------------------------------------------

resource "google_redis_instance" "main" {
  # Only created when channels are connected — it is the single largest line
  # item, and a property not yet selling through an OTA has no queue to hold.
  count = var.enable_channel_sync ? 1 : 0

  name           = "deehub-${local.suffix}"
  tier           = "BASIC"
  memory_size_gb = var.redis_memory_gb
  region         = var.region

  authorized_network = google_compute_network.main.id
  connect_mode       = "PRIVATE_SERVICE_ACCESS"
  redis_version      = "REDIS_7_0"

  # BullMQ keeps queued jobs here. Losing Redis costs throughput and a resync,
  # never data — the outbox lives in Postgres (architecture.md §7).
  depends_on = [google_service_networking_connection.private_vpc]
}
