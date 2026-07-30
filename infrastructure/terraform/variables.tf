variable "project_id" {
  description = "Google Cloud project."
  type        = string
}

variable "region" {
  description = "Deployment region. asia-southeast1 (Singapore) is the closest to Thailand."
  type        = string
  default     = "asia-southeast1"
}

variable "environment" {
  description = "Environment name, used as a resource suffix."
  type        = string
  default     = "prod"
}

variable "enable_channel_sync" {
  description = <<-EOT
    Creates Memorystore and the always-on worker.

    MUST be true before activating any OTA channel. With it false the API,
    dashboard and scheduled maintenance all work, and a property can take and
    manage bookings — but nothing is pushed to a channel. The relay fails loudly
    and leaves the event unpublished if a channel is activated anyway, so the
    failure is visible rather than silent, but it is still a failure.

    False is the right setting only before the first OTA is connected; it saves
    roughly $58/month (docs/deployment.md §8).
  EOT
  type        = bool
  default     = false
}

variable "worker_cpu" {
  description = "vCPU for the always-on worker. Billed for every second of the month."
  type        = string
  default     = "0.5"
}

variable "worker_memory" {
  description = "Memory for the always-on worker."
  type        = string
  default     = "512Mi"
}

variable "maintenance_schedule" {
  # Hourly is ample with no channels connected: the outbox has only local
  # housekeeping to do, and reconciliation is the part that matters.
  description = "Cron for the maintenance job, in the property timezone."
  type        = string
  default     = "0 * * * *"
}

variable "db_tier" {
  # db-g1-small is the smallest tier that is not shared-core; it is enough for a
  # handful of pilot properties and is trivially resizable later.
  description = "Cloud SQL machine tier. Shared-core tiers have no SLA."
  type        = string
  default     = "db-f1-micro"
}

variable "redis_memory_gb" {
  description = "Memorystore size. 1GB is the minimum Basic tier offers."
  type        = number
  default     = 1
}

variable "db_disk_gb" {
  description = "Cloud SQL storage. Autoresizes, so start small."
  type        = number
  default     = 10
}

variable "api_image" {
  description = "Fully qualified API image. Set by CI on each deploy."
  type        = string
}

variable "web_image" {
  description = "Fully qualified dashboard image. Set by CI on each deploy."
  type        = string
}

variable "cors_origins" {
  description = "Origins allowed to call the API directly."
  type        = string
  default     = ""
}
