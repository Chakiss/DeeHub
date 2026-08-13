# --- Global load balancer -----------------------------------------------------
#
# Why this exists at all: Cloud Run's own domain mappings issue their own
# certificates, and twice in a row they did not. `api.` got one within the hour.
# `app.` never did, was abandoned, and `dashboard.` — a different name, identical
# DNS, same apply — sat six hours presenting NO certificate at all while the API
# reported CertificatePending and retried hourly. Two names failing the same way
# against the same service is not a name problem, and there is nothing left on
# our side to correct: the CNAME, the A and the AAAA records are byte-identical
# to the ones the working host uses, there is no CAA record and no proxy.
#
# So certificate issuance moves to something we can see into. A Google-managed
# certificate on a load balancer reports its state per domain
# (`terraform output lb_certificate_state`), which is the difference between
# waiting and debugging.
#
# It also buys two things the mappings could never give us:
#
#   * the apex and www, which Cloud Run domain mappings handle badly and which
#     the marketing site needs;
#   * a place to attach Cloud Armor when the public booking routes get rate
#     limiting (decisions-pending-review.md §17) — that needs a load balancer
#     and this is it.
#
# Cost is a real trade and it is why this was not the first choice: roughly
# $18-25/month for the forwarding rule and its traffic, against $0 for a domain
# mapping that works. It is worth it here because a dashboard nobody can reach
# on its own domain is worth less than $25.
#
# `api.<domain>` deliberately stays on its Cloud Run domain mapping. It works,
# and a managed certificate does not go ACTIVE until EVERY domain on it
# validates — putting api. on this certificate while its DNS still points at
# ghs.googlehosted.com would block the certificate for the two hosts that need
# it. Moving it later is a DNS change plus one line here.

locals {
  lb_enabled = var.custom_domain == "" ? 0 : 1

  # The hosts this load balancer terminates TLS for. api. is absent on purpose;
  # see the note above.
  lb_domains = var.custom_domain == "" ? [] : [
    "dashboard.${var.custom_domain}",
    var.custom_domain,
    "www.${var.custom_domain}",
  ]
}

resource "google_compute_global_address" "lb" {
  count = local.lb_enabled
  name  = "deehub-lb-${local.suffix}"
}

# --- The marketing site, as objects rather than a service ---------------------
#
# apps/marketing is 2 MB of hand-written HTML, CSS, images and fonts with no
# build step and no server behaviour. A Cloud Run service for it — which the
# marketing site plan assumed — would be a container to build, deploy, scale to
# zero and cold-start, to hand back bytes that never change between deploys.
# A bucket behind the load balancer has no cold start and no container.
#
# Contents are NOT managed here. CI syncs them on merge, the same as every
# other deployable, so editing a headline does not mean a Terraform apply from
# somebody's laptop (decisions-pending-review.md §18 is about exactly that gap).

resource "google_storage_bucket" "marketing" {
  count    = local.lb_enabled
  name     = "deehub-marketing-${local.suffix}-${var.project_id}"
  location = var.region

  uniform_bucket_level_access = true

  # Serves index.html for `/` and for `/en/`, which is the whole routing story
  # this site has.
  website {
    main_page_suffix = "index.html"
    not_found_page   = "index.html"
  }
}

# A public bucket, deliberately: it holds a marketing site. Nothing else may be
# written here — the object sync in CI is the only writer.
resource "google_storage_bucket_iam_member" "marketing_public" {
  count  = local.lb_enabled
  bucket = google_storage_bucket.marketing[0].name
  role   = "roles/storage.objectViewer"
  member = "allUsers"
}

resource "google_compute_backend_bucket" "marketing" {
  count       = local.lb_enabled
  name        = "deehub-marketing-${local.suffix}"
  bucket_name = google_storage_bucket.marketing[0].name

  # Static bytes with fingerprinted-enough names; caching them at the edge is
  # the entire reason to put a marketing site on a CDN.
  enable_cdn = true
  cdn_policy {
    cache_mode        = "CACHE_ALL_STATIC"
    client_ttl        = 3600
    default_ttl       = 3600
    max_ttl           = 86400
    negative_caching  = true
    serve_while_stale = 86400
  }
}

# --- The dashboard, through a serverless NEG ----------------------------------

resource "google_compute_region_network_endpoint_group" "web" {
  count                 = local.lb_enabled
  name                  = "deehub-web-neg-${local.suffix}"
  region                = var.region
  network_endpoint_type = "SERVERLESS"

  cloud_run {
    service = google_cloud_run_v2_service.web.name
  }
}

resource "google_compute_backend_service" "web" {
  count                 = local.lb_enabled
  name                  = "deehub-web-${local.suffix}"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTPS"

  backend {
    group = google_compute_region_network_endpoint_group.web[0].id
  }

  # No timeout_sec: the API refuses it outright for serverless NEGs ("Timeout
  # sec is not supported", found by the first apply). Cloud Run's own request
  # timeout governs instead, which is 300s by default — cold starts are fine.

  log_config {
    enable      = true
    sample_rate = 1.0
  }
}

# --- Certificate --------------------------------------------------------------
#
# Google-managed, one certificate covering all three hosts. It stays
# PROVISIONING until every domain on it resolves to the address above — so the
# DNS records move BEFORE this goes ACTIVE, not after. Check with:
#
#   terraform output lb_certificate_state
#
# create_before_destroy because a certificate cannot be updated in place: adding
# a domain replaces it, and without this the replacement is destroyed first and
# the site serves nothing in between.

resource "google_compute_managed_ssl_certificate" "main" {
  count = local.lb_enabled
  name  = "deehub-cert-${local.suffix}"

  managed {
    domains = local.lb_domains
  }

  lifecycle {
    create_before_destroy = true
  }
}

# --- Routing ------------------------------------------------------------------

resource "google_compute_url_map" "main" {
  count = local.lb_enabled
  name  = "deehub-lb-${local.suffix}"

  # Anything that is not the dashboard is the marketing site. That includes the
  # apex and www, and it includes a request arriving on the load balancer's bare
  # IP address — which should look like a marketing site, not like a sign-in page.
  default_service = google_compute_backend_bucket.marketing[0].id

  host_rule {
    hosts        = ["dashboard.${var.custom_domain}"]
    path_matcher = "dashboard"
  }

  path_matcher {
    name            = "dashboard"
    default_service = google_compute_backend_service.web[0].id
  }

  host_rule {
    hosts        = ["www.${var.custom_domain}"]
    path_matcher = "www"
  }

  # www redirects to the apex rather than serving the same bytes twice: two
  # addresses for one page splits its search ranking and its analytics.
  path_matcher {
    name = "www"
    default_url_redirect {
      host_redirect          = var.custom_domain
      https_redirect         = true
      redirect_response_code = "MOVED_PERMANENTLY_DEFAULT"
      strip_query            = false
    }
  }
}

resource "google_compute_target_https_proxy" "main" {
  count            = local.lb_enabled
  name             = "deehub-https-${local.suffix}"
  url_map          = google_compute_url_map.main[0].id
  ssl_certificates = [google_compute_managed_ssl_certificate.main[0].id]
}

resource "google_compute_global_forwarding_rule" "https" {
  count                 = local.lb_enabled
  name                  = "deehub-https-${local.suffix}"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  port_range            = "443"
  target                = google_compute_target_https_proxy.main[0].id
  ip_address            = google_compute_global_address.lb[0].id
}

# --- Port 80, which exists only to send people to port 443 ---------------------
#
# Not optional. Nobody types https://, and a domain that hangs on http:// reads
# as a broken site rather than as a redirect nobody wrote.

resource "google_compute_url_map" "redirect" {
  count = local.lb_enabled
  name  = "deehub-redirect-${local.suffix}"

  default_url_redirect {
    https_redirect         = true
    redirect_response_code = "MOVED_PERMANENTLY_DEFAULT"
    strip_query            = false
  }
}

resource "google_compute_target_http_proxy" "redirect" {
  count   = local.lb_enabled
  name    = "deehub-http-${local.suffix}"
  url_map = google_compute_url_map.redirect[0].id
}

resource "google_compute_global_forwarding_rule" "http" {
  count                 = local.lb_enabled
  name                  = "deehub-http-${local.suffix}"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  port_range            = "80"
  target                = google_compute_target_http_proxy.redirect[0].id
  ip_address            = google_compute_global_address.lb[0].id
}
