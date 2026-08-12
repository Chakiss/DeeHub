# --- Custom domain -----------------------------------------------------------
# Two subdomains, created only when var.custom_domain is set:
#
#   app.<domain>   the dashboard
#   api.<domain>   the API
#
# The apex is deliberately NOT mapped. It belongs to the guest-facing booking
# site (roadmap Phase 3), which is not built; pointing it at the dashboard to
# fill the space now means moving it later, after staff have bookmarked it and
# after it has been printed on something.
#
# Two conditions must hold before an apply here succeeds, and the error when
# they do not is not obvious:
#
#   1. **The domain is verified to whoever runs Terraform.** `gcloud domains
#      verify deehubhotel.com` opens Search Console; ownership is proved with a
#      TXT record. Applies run from an operator's laptop — there is no
#      terraform step in .github/workflows — so this is a human's own Search
#      Console ownership, and no service account needs adding as a co-owner.
#      Unverified, the create fails with a 403 that talks about permissions on
#      the domain rather than about verification.
#
#   2. **The DNS records below exist at the registrar.** Cloud Run issues the
#      TLS certificate itself through Let's Encrypt and cannot do so until the
#      name already resolves to it, so the mapping sits in CertificatePending
#      — serving nothing — until the records are live. Terraform reports the
#      mapping as created either way; created is not the same as serving.
#      `terraform output custom_domain_dns_records` prints exactly what to add.
#
# Nothing here changes the run.app URLs. They keep working, which is what makes
# this reversible: unset the variable and the mapping goes away.

resource "google_cloud_run_domain_mapping" "web" {
  count    = var.custom_domain == "" ? 0 : 1
  name     = "app.${var.custom_domain}"
  location = var.region

  metadata {
    namespace = var.project_id
  }

  spec {
    route_name = google_cloud_run_v2_service.web.name
  }

  # The API writes its own annotations onto the object (an operation id, a
  # serving state) and returns them on every read. Without this, every plan
  # forever shows them being removed and every apply is a no-op — which is how
  # people learn to stop reading plans.
  lifecycle {
    ignore_changes = [metadata[0].annotations, metadata[0].labels]
  }
}

resource "google_cloud_run_domain_mapping" "api" {
  count    = var.custom_domain == "" ? 0 : 1
  name     = "api.${var.custom_domain}"
  location = var.region

  metadata {
    namespace = var.project_id
  }

  spec {
    route_name = google_cloud_run_v2_service.api.name
  }

  lifecycle {
    ignore_changes = [metadata[0].annotations, metadata[0].labels]
  }
}
