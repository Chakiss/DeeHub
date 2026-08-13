output "api_url" {
  value       = google_cloud_run_v2_service.api.uri
  description = "Public API endpoint."
}

output "dashboard_url" {
  value       = google_cloud_run_v2_service.web.uri
  description = "Admin dashboard."
}

output "custom_domain_dns_records" {
  description = <<-EOT
    Every record to create at the registrar, in one list.

    The load balancer's hosts are plain A records to one address. api. keeps its
    CNAME to Cloud Run. Empty until custom_domain is set.

    Nothing serves until these resolve: a Google-managed certificate stays
    PROVISIONING until each of its domains points at the load balancer, and
    Cloud Run will not issue for a name that does not point at it either. Create
    the records, then watch `lb_certificate_state`.

    At Cloudflare every one of these must be DNS-only. A proxied record answers
    with Cloudflare's own address, the validator never sees ours, and the
    certificate waits forever.
  EOT
  value = concat(
    [
      for host in local.lb_domains : {
        host  = host
        type  = "A"
        value = try(google_compute_global_address.lb[0].address, "")
      }
    ],
    flatten([
      for m in google_cloud_run_domain_mapping.api : [
        for r in try(m.status[0].resource_records, []) : {
          host  = m.name
          type  = r.type
          value = r.rrdata
        }
      ]
    ])
  )
}

output "lb_address" {
  value       = try(google_compute_global_address.lb[0].address, "")
  description = "The load balancer's static IP. Every A record above points here."
}

output "lb_certificate_check" {
  description = <<-EOT
    How to watch the certificate. The provider does not export its status — the
    resource carries only its name and expiry — so this is the command rather
    than the answer.

    It reports PER DOMAIN, which is the thing Cloud Run's domain mappings never
    told us and half the reason this load balancer exists. A domain at
    FAILED_NOT_VISIBLE is one whose DNS does not point here yet, or is proxied.
    ACTIVE everywhere means it is serving. Expect 15-60 minutes after the
    records go live.
  EOT
  value = try(
    "gcloud compute ssl-certificates describe ${google_compute_managed_ssl_certificate.main[0].name} --global --project=${var.project_id} --format='yaml(managed.status, managed.domainStatus)'",
    ""
  )
}

output "marketing_bucket" {
  value       = try(google_storage_bucket.marketing[0].name, "")
  description = "Bucket CI syncs apps/marketing into. Empty until custom_domain is set."
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
