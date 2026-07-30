output "api_url" {
  value       = google_cloud_run_v2_service.api.uri
  description = "Public API endpoint."
}

output "dashboard_url" {
  value       = google_cloud_run_v2_service.web.uri
  description = "Admin dashboard."
}

output "artifact_registry" {
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images.repository_id}"
  description = "Push images here."
}

output "database_instance" {
  value       = google_sql_database_instance.main.name
  description = "Cloud SQL instance name."
}

output "channel_sync_enabled" {
  value       = var.enable_channel_sync
  description = "Whether Memorystore and the always-on worker exist. Must be true before connecting an OTA."
}

output "service_accounts" {
  value = {
    api    = google_service_account.api.email
    worker = google_service_account.worker.email
    web    = google_service_account.web.email
  }
}
