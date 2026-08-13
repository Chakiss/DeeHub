# --- Custom domain -----------------------------------------------------------
# One subdomain is served from here, created only when var.custom_domain is set:
#
#   api.<domain>         the API
#
# Everything else — the dashboard, the apex and www — is served by the load
# balancer in loadbalancer.tf, after Cloud Run's own certificate issuance failed
# twice on two different names. The story is in that file's header.
#
# The apex is no longer empty. It carries the MARKETING site, which is what an
# apex is for; the guest-facing booking engine (roadmap Phase 3) gets its own
# name when it exists rather than the address a stranger types to find out who
# we are. That supersedes decisions-pending-review.md §19, whose reasoning —
# do not park something on the apex that will have to move later — is the same
# reasoning that puts the marketing site there permanently.
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

# The dashboard's mapping is GONE, and this is what replaced it.
#
# `dashboard.` behaved exactly as `app.` had: created 2026-08-13 12:28, still
# presenting no certificate at all six hours later, with DNS byte-identical to
# the api. records that worked. Two names, same failure, same target service —
# the name was never the variable. It now runs through the load balancer in
# loadbalancer.tf, whose certificate reports its state per domain instead of
# retrying in silence.
#
# api. stays here because it works, and because a managed certificate is only
# ACTIVE once every domain on it validates — adding api. to the load balancer's
# certificate before moving its DNS would hold up the two hosts that need it.

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
