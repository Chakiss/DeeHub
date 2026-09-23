# --- Static egress address ------------------------------------------------------
#
# Google's Hotel Center authenticates ARI uploads by the SENDER'S IP: the
# address is allow-listed in Hotel Center's price settings and there is no
# other credential. Cloud Run's outbound address is otherwise whatever Google
# Front End the request happened to leave through, so the API and the
# maintenance job — the two things that push — leave through Cloud NAT on one
# reserved address instead. `terraform output egress_address` is the value to
# paste into Hotel Center.
#
# ALL_TRAFFIC egress means every outbound call (Resend, Omise, Sentry) also
# goes through the NAT. The volumes are tiny; the cost is the reserved address
# and the gateway's per-hour charge — a few dollars a month. Rolling back is
# setting local.vpc_egress back to PRIVATE_RANGES_ONLY.

resource "google_compute_address" "egress" {
  name   = "deehub-egress-${local.suffix}"
  region = var.region
}

resource "google_compute_router" "main" {
  name    = "deehub-router-${local.suffix}"
  region  = var.region
  network = google_compute_network.main.id
}

resource "google_compute_router_nat" "main" {
  name   = "deehub-nat-${local.suffix}"
  router = google_compute_router.main.name
  region = var.region

  nat_ip_allocate_option = "MANUAL_ONLY"
  nat_ips                = [google_compute_address.egress.self_link]

  source_subnetwork_ip_ranges_to_nat = "LIST_OF_SUBNETWORKS"
  subnetwork {
    name                    = google_compute_subnetwork.main.id
    source_ip_ranges_to_nat = ["ALL_IP_RANGES"]
  }

  log_config {
    enable = true
    filter = "ERRORS_ONLY"
  }
}
