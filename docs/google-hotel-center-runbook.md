# Google Hotel Center — runbook

What has to happen outside the code for a hotel's DeeHub price to appear on
Google Search and Maps as its official site, and for the link to land on
`book.deehubhotel.com`. Design in [ADR-0010](adr/0010-google-hotels-as-a-channel.md).

## 1. Once, for DeeHub (the connectivity partner)

1. **Apply.** Hotel Center → _Connectivity partners: how to get started_ → Step
   1, the interest form. Company: DeeHub; site: deehubhotel.com; type: PMS +
   booking engine; properties: the pilot and the pipeline. Google reviews the
   business (weeks), then creates the Hotel Center account and issues the
   **partner key** — set it as `google_hotel_partner_key` in Terraform.
2. **Static address.** `terraform apply` (creates the NAT and the reserved IP),
   then `terraform output egress_address` → Hotel Center → _Price settings_ →
   IP allow-list.
3. **Hotel List Feed.** `set-secrets.sh` generates the feed key. In Hotel
   Center → _Property data_ → _Hotel list_, give the URL
   `https://api.deehubhotel.com/api/v1/public/google/hotel-list.xml?key=<key>`
   (the key is in Secret Manager: `deehub-google-hotel-feed-key-prod`). Google
   fetches it weekly and matches each `<id>` to a Google Maps listing;
   unmatched properties show in the _Properties_ tab with a matching tool.
4. **Landing pages.** Upload `docs/google/landing-pages.xml` under
   _Landing pages_. One template for every hotel.
5. **Test property.** Hotel Center gives a test property; activate a Google
   channel on the pilot, force a sync, and watch _Feed status_ and the _Price
   accuracy_ report until they are clean. Certification is Google's, on their
   schedule (their guide says weeks 10–13).

## 2. Per hotel

1. Dashboard → _Settings_: address, phone, coordinates, description, photos.
   The address and coordinates are what Google matches on.
2. _Rates_: untick **Sell online** on any plan the desk keeps to itself.
3. _Channels_ → _Add channel_ → type **GOOGLE_HOTEL** → _Map every room type
   and online rate under its own code_ → _Activate_ (this sends the property
   data) → _Sync now_. _Test connection_ answers "not on the allow-list" if
   step 1.2 was missed.
4. From then on every price or availability change reaches Google within the
   maintenance job's interval (five minutes), from `ari_sync_requests`.
5. **The official-site badge.** Google attaches it to the website in the
   hotel's Google Business Profile. The hotel sets that website to
   `https://book.deehubhotel.com/{org}/{code}` (or its own domain pointing
   there) — and stops its previous provider's feed the same day, or Google
   shows two "official" prices.

## 3. What to watch

- Dashboard → _Channels_: the Google channel's last sync and last error.
- Maintenance job logs: `Channel sync: pushed N, failed N, abandoned N`. An
  abandoned group is ten failed rounds; the channel carries the error.
- Hotel Center → _Price accuracy_: a mismatch means the page and the feed
  disagree, which should be impossible (same function) — look for a stale
  push first (`ari_sync_requests` with `status = 'PENDING'`).
