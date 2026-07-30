# --- Alerting ----------------------------------------------------------------
#
# The system already detects its own worst failures and told nobody. The hourly
# maintenance job exits non-zero on inventory drift or a stuck outbox — drift
# means a bug in the booking path, and a stuck outbox means an OTA is being told
# nothing — and that exit code went into Cloud Run's history to be read by
# whoever happened to look.
#
# Deliberately few policies. An inbox that alerts on everything is an inbox
# nobody opens, and these are the three that mean "a guest is about to be
# affected".

resource "google_monitoring_notification_channel" "email" {
  display_name = "DeeHub operator"
  type         = "email"

  labels = {
    email_address = var.alert_email
  }

  # Google sends a confirmation link to this address. Until it is clicked the
  # channel exists but delivers nothing, which is worth knowing before trusting
  # the silence.
  depends_on = [google_project_service.enabled]
}

/**
 * The alarm that already existed with no bell attached.
 *
 * A failed execution is the maintenance job's way of reporting inventory drift,
 * outbox events that cannot be published, or its own crash. All three want a
 * human the same morning.
 */
resource "google_monitoring_alert_policy" "maintenance_failed" {
  display_name = "Maintenance job failed (${local.suffix})"
  combiner     = "OR"

  conditions {
    display_name = "A maintenance run did not complete"

    condition_threshold {
      filter = join(" AND ", [
        "resource.type = \"cloud_run_job\"",
        "resource.labels.job_name = \"${google_cloud_run_v2_job.maintenance.name}\"",
        "metric.type = \"run.googleapis.com/job/completed_execution_count\"",
        "metric.labels.result = \"failed\"",
      ])

      comparison = "COMPARISON_GT"
      # One failure is enough. This job runs hourly and a single bad run is a
      # real signal, not noise.
      threshold_value = 0
      duration        = "0s"

      aggregations {
        alignment_period   = "3600s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.email.id]

  alert_strategy {
    # Close it after three quiet hours rather than leaving it open forever: the
    # job runs hourly, so three clean runs is a real recovery.
    auto_close = "10800s"
  }

  documentation {
    content = join("\n", [
      "The hourly maintenance job failed. It reports three different problems the same way:",
      "",
      "1. INVENTORY DRIFT — booked counts disagree with the reservations behind them.",
      "   This means a bug in the booking path and should be looked at today.",
      "2. Outbox events that cannot be published — an OTA is not being told about bookings.",
      "3. The job itself crashed.",
      "",
      "Read the reason:",
      "  gcloud run jobs executions list --job=${google_cloud_run_v2_job.maintenance.name} --region=${var.region}",
      "  gcloud logging read 'resource.type=\"cloud_run_job\"' --limit=50 --freshness=2h",
    ])
    mime_type = "text/markdown"
  }
}

/**
 * Server errors reaching guests.
 *
 * Distinct from the job alert: this is the API failing in front of somebody
 * trying to book. The threshold is deliberately not zero — a single 5xx from a
 * cold start is not worth waking anyone — but a sustained rate is.
 */
resource "google_monitoring_alert_policy" "api_errors" {
  display_name = "API returning server errors (${local.suffix})"
  combiner     = "OR"

  conditions {
    display_name = "5xx responses from the API"

    condition_threshold {
      filter = join(" AND ", [
        "resource.type = \"cloud_run_revision\"",
        "resource.labels.service_name = \"${google_cloud_run_v2_service.api.name}\"",
        "metric.type = \"run.googleapis.com/request_count\"",
        "metric.labels.response_code_class = \"5xx\"",
      ])

      comparison      = "COMPARISON_GT"
      threshold_value = 5
      # Sustained for five minutes, so a blip during a deploy stays quiet.
      duration = "300s"

      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.email.id]
  alert_strategy {
    auto_close = "3600s"
  }

  documentation {
    content   = "The API is returning 5xx. Check Error Reporting, then the revision logs."
    mime_type = "text/markdown"
  }
}

/**
 * The database filling up.
 *
 * On the cheap tier the disk is small, and Cloud SQL stops accepting writes
 * when it is full — which presents as the hotel being unable to take a booking.
 * Warned at 85% so there is time to resize before that.
 */
resource "google_monitoring_alert_policy" "database_disk" {
  display_name = "Database disk almost full (${local.suffix})"
  combiner     = "OR"

  conditions {
    display_name = "Disk above 85%"

    condition_threshold {
      filter = join(" AND ", [
        "resource.type = \"cloudsql_database\"",
        "metric.type = \"cloudsql.googleapis.com/database/disk/utilization\"",
      ])

      comparison      = "COMPARISON_GT"
      threshold_value = 0.85
      duration        = "600s"

      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MEAN"
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.email.id]
  alert_strategy {
    auto_close = "86400s"
  }

  documentation {
    content   = "Cloud SQL stops accepting writes when the disk fills. Raise db_disk_gb and apply."
    mime_type = "text/markdown"
  }
}
