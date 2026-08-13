# Removing the load balancer — plan before touching anything

Written 2026-08-13, hours after `loadbalancer.tf` went live, when the founder
asked whether it can come back out. It can, and the honest answer is that the
cheapest stable end-state never needed it — what it bought today was speed and
visibility on a day the certificate had already burned six hours.

Nothing in this plan is executed. §7 is the one decision it needs first.

---

## 1. Business goal

Cut the **~$18–19/month fixed cost** (plus per-GB fees) of the load balancer —
the second-largest line on the bill, ~40% of the current ~$40–47 total — without
losing anything that works today:

- `deehubhotel.com` + `www` serving the marketing site
- `dashboard.deehubhotel.com` serving the dashboard
- `api.deehubhotel.com` untouched throughout — it was never on the LB
- Reset links and CORS staying correct at every step

Target end-state: web serving costs **$0/month**, total bill back to ~$22–28.

## 2. What the LB does today, and what replaces each piece

| Today (LB)                            | Replacement                                                                                         | Cost |
| ------------------------------------- | --------------------------------------------------------------------------------------------------- | ---- |
| apex + www → GCS bucket + CDN         | **Cloudflare Pages** — static hosting on the CDN whose nameservers we already use                   | $0   |
| dashboard → Cloud Run NEG             | **Cloud Run domain mapping, third attempt** — §4 says why the odds are better than 0-for-2 suggests | $0   |
| www → apex 301                        | Cloudflare redirect rule                                                                            | $0   |
| Cloud Armor attachment point (future) | Not needed on this path — §5                                                                        | —    |

Cloudflare Pages rather than Firebase Hosting because the DNS is already at
Cloudflare, the marketing site is 2 MB of static files with no build step, and
it adds no new Google product to the stack. Firebase Hosting is the fallback
(§4) precisely because it can also proxy to Cloud Run.

## 3. Why removing it is defensible the same day it was added

The LB was chosen to end a six-hour outage with something observable, and it
did. But today's provisioning also produced evidence we did not have this
morning:

- The certificate validated **within ~50 minutes** once the records were plain
  A records, DNS-only — proving there is nothing wrong with the domain, the
  zone, or the registrar.
- `FAILED_NOT_VISIBLE` appeared and cleared on its own, showing the failure
  mode is Google's resolver caching a pre-change answer, not a permanent state.

The original `app.`/`dashboard.` mapping failures were never explained. The
most likely remaining hypothesis is stale negative caching against records that
had recently changed shape (CNAME created, possibly proxied at some point) —
the same transient state we watched resolve itself today on the LB path. That
is why a third mapping attempt is worth one hour of patience, and why it gets a
pre-agreed fallback instead of another day of waiting.

## 4. Migration sequence — nothing is destroyed until its replacement serves

Order matters; each step is reversible and the LB keeps serving until step 6.

1. **Marketing to Cloudflare Pages.** Create the Pages project, upload
   `apps/marketing`, verify on the `*.pages.dev` preview URL. No DNS change
   yet. Needs a `CLOUDFLARE_API_TOKEN` (founder's action, §7) for CI.
2. **Switch apex + www to Pages.** At Cloudflare this is internal — Pages
   custom domains on a Cloudflare-managed zone activate with Cloudflare's own
   universal certificate, so there is **no provisioning gap** for the marketing
   site. Add the www→apex redirect rule.
3. **Recreate the dashboard domain mapping** (`google_cloud_run_domain_mapping`
   back in Terraform), then flip `dashboard.` from the LB's A record back to
   the `ghs.googlehosted.com` CNAME, DNS-only. **This opens the one real gap:**
   the custom name serves nothing until the certificate issues. The dashboard
   stays fully usable on its run.app URL throughout, and reset links stay
   valid — `admin_web_url` is only ever read when a link is minted, and a
   link's lifetime is one hour.
4. **Time-box the gap: 2 hours.** If the certificate is not serving by then,
   execute the fallback without further debate: **Firebase Hosting** with a
   rewrite proxying `dashboard.` to `deehub-web-prod` — still $0, still
   Google-managed TLS, different provisioning path than the one that failed.
   (`terraform output` equivalents and the check commands are in
   deployment.md §2.)
5. **CORS bridge.** `cors_origins` already names both the custom domain and the
   run.app URL — added for exactly this kind of window. It stays that way until
   step 6.
6. **Destroy the LB.** Remove `loadbalancer.tf` (and the bucket + its CI sync
   step, replaced by the Pages deploy), `terraform apply`. Billing for the
   forwarding rules stops that hour. Update deployment.md §2/§8 and
   decisions-pending-review.md §22.

Total founder actions: one API token, two DNS edits, one apply (or grant).

## 5. What is genuinely lost

- **Cloud Armor has nowhere to attach.** Today that costs nothing: the API —
  where rate limiting is actually needed (decisions-pending-review.md §17) —
  was never behind the LB anyway. When channel sync turns on, **Redis arrives
  with it**, and app-level rate limiting on Redis is the natural path. If we
  ever do want Cloud Armor, this plan is simply run in reverse; `loadbalancer.tf`
  stays in git history, debugged and working.
- **Marketing moves off Google.** Its deploy becomes a Cloudflare token in CI
  instead of a bucket sync. Acceptable; it is a brochure.
- **Per-domain certificate visibility** — the thing the LB was bought for. If
  the third mapping attempt fails we fall back to Firebase, not to silence.

## 6. Risks

| Risk                                                                | Answer                                                                                                                                                             |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Dashboard mapping fails a third time                                | Pre-agreed 2-hour time-box, then Firebase Hosting proxy. No open-ended waiting like this morning                                                                   |
| A proxied (orange-cloud) record sneaks in on `dashboard.` or `api.` | Both must stay DNS-only forever — Cloud Run certificates also **renew** through DNS visibility. apex/www proxied is fine and expected on Pages                     |
| Marketing deploy breaks silently after the bucket step is removed   | The Pages deploy replaces it in the same workflow file, same trigger; a missing token fails the step loudly                                                        |
| LB destroyed before something serves                                | The sequence forbids it: destroy is step 6, replacements serve at steps 2 and 3/4                                                                                  |
| Rollback                                                            | `git revert` of the removal commit + `terraform apply` recreates the LB; the certificate re-provisions in under an hour as proven today. DNS back to the A records |

## 7. The decision needed before starting

**Accept the dashboard gap, or pre-empt it.** Step 3 has a window — likely
under an hour, time-boxed at two — where `dashboard.deehubhotel.com` does not
serve and staff use the run.app URL. Tonight that costs almost nothing (one
pilot property, founder-operated). The alternative is to skip the third mapping
attempt entirely and go straight to Firebase Hosting for the dashboard: no gap,
but a new product in the stack for a problem the mapping might not have.

Also needed from the founder: a Cloudflare API token (Pages:Edit) as a GitHub
secret, and the two DNS edits — or Claude drives them through the Cloudflare
dashboard in a logged-in browser.

## 8. Cost delta

|                | Fixed/month         |
| -------------- | ------------------- |
| Today, with LB | ~$40–47             |
| After removal  | **~$22–28**         |
| Saved          | ~$18–19 + data fees |

The saving holds until channel sync turns on (+$80 for Redis + worker), which
dwarfs it — worth remembering that the next real cost decision is that one, and
deployment.md §8's option B (queue in Postgres, drop Redis) is the counter to
it.
