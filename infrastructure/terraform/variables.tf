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
  # Hourly was ample when the outbox had only local housekeeping to do. This
  # job now also SENDS notifications, so the interval is how long a guest waits
  # for a booking confirmation — every ten minutes is the compromise between
  # that and a Cloud Run job that runs 144 times a day for nothing.
  #
  # Deployments running the always-on worker do not use this at all: it sends
  # within seconds.
  description = "Cron for the maintenance job, in the property timezone."
  type        = string
  default     = "*/10 * * * *"
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

# Where the dashboard is served, for links the API puts in an email — today
# just the password-reset link.
#
# A variable rather than a reference to google_cloud_run_v2_service.web.uri,
# because the web service already reads the api service's URI and Terraform
# cannot resolve a cycle between them. Two-pass bootstrap: apply once, read
# `terraform output dashboard_url`, set this, apply again. A custom domain
# short-circuits that — set it here from the start.
#
# Left empty the API falls back to the first CORS origin, and refuses to send
# a reset link at all in production rather than mail out a localhost address.
variable "admin_web_url" {
  description = "Public URL of the admin dashboard, e.g. https://deehub-web-xxxx.a.run.app"
  type        = string
  default     = ""
}

variable "alert_email" {
  type        = string
  description = "Where alerts go. Google emails a confirmation link that must be clicked before anything is delivered."
}

variable "email_from" {
  # Must be a sender Resend has verified. With no verified domain the only
  # address that works is onboarding@resend.dev, and it can only deliver to the
  # Resend account owner — enough to prove the pipeline, not enough for guests.
  description = "Verified sender for guest email, e.g. \"Baan Suan <bookings@example.com>\". Empty disables email."
  type        = string
  default     = ""
}

variable "line_staff_target" {
  description = "LINE user or group id that staff alerts are pushed to. Empty disables LINE."
  type        = string
  default     = ""
}
