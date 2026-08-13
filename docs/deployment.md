# DeeHub Hotel — Deployment

Engineering Task 13. How DeeHub is built, shipped and rolled back on Google
Cloud ([ADR-0004](adr/0004-google-cloud.md)).

---

## 1. What runs where

Two images, and — depending on `enable_channel_sync` — two or three services
plus two jobs.

### Two modes

|                 | `enable_channel_sync = false`  | `= true`            |
| --------------- | ------------------------------ | ------------------- |
| Memorystore     | not created                    | 1GB Basic           |
| Worker service  | not created                    | always-on, min 1    |
| Maintenance job | hourly (the only housekeeping) | hourly (safety net) |
| OTA sync        | **none**                       | full two-way        |
| Cost            | **~$22/month**                 | ~$70–83/month       |

`false` is correct only until the first OTA is connected. The API, dashboard
and scheduled maintenance all work: a property can take bookings, manage
inventory and rates, and inventory drift is still checked nightly. Nothing is
pushed to a channel.

If a channel is activated anyway the relay **fails loudly** — the event stays
unpublished with the error recorded, and the maintenance job exits non-zero so
the scheduler surfaces it. That is a visible failure, not a silent one, but it
is still a failure: **set `enable_channel_sync = true` before activating any
channel.**

Verified behaviour with no Redis configured: the API boots and serves normally;
the relay publishes events for properties with no active channel; the worker
refuses to start rather than idling; and an event for an active channel is
preserved with its error rather than dropped.

### Processes

| Workload   | Image              | Command                         | Scaling                              |
| ---------- | ------------------ | ------------------------------- | ------------------------------------ |
| API        | `api`              | `node dist/main.js`             | Cloud Run, **scale to zero**, max 10 |
| Worker     | `api` (same image) | `node dist/worker.js`           | Cloud Run, **min 1**, max 3          |
| Dashboard  | `web`              | `node apps/admin-web/server.js` | Cloud Run, scale to zero, max 10     |
| Migrations | `api` (same image) | `node dist/database/migrate.js` | Cloud Run **Job**, run by CI         |

The API and worker deliberately share one image so both processes provably run
identical domain code (architecture.md §1).

Two scaling settings are load-bearing rather than tuning:

- **The worker must never scale to zero.** It polls Redis and drains the
  outbox. At zero instances no booking would ever reach an OTA, and nothing
  would report an error — the exact silent-staleness failure the whole outbox
  design exists to prevent.
- **The worker runs with `cpu_idle = false`.** Cloud Run's default only
  allocates CPU during a request; a background loop would be throttled to a
  crawl between them.

Supporting infrastructure: Cloud SQL for PostgreSQL 17 (private IP, PITR
enabled), Memorystore for Redis, Cloud Storage for media, Secret Manager for
every credential, Artifact Registry for images.

---

### Pausing scheduled maintenance

`maintenance_paused = true` stops the Cloud Scheduler trigger, so the job never
runs. It exists for one situation: the alert email has become noise the
operator has stopped reading. Pausing removes the noise by removing the signal,
which is only defensible while the deployment has no live guests — and never
the right first move if the job still mostly succeeds, because it trades
working housekeeping for a quiet inbox.

On `enable_channel_sync = false` this job is the only housekeeping process, so
while it is paused:

| Stops                        | Consequence                                             |
| ---------------------------- | ------------------------------------------------------- |
| Outbox relay + notifications | Confirmations are composed and never sent               |
| Hold expiry                  | Lapsed holds keep nights off sale indefinitely          |
| OTB snapshot capture         | Permanent gap in the pickup report's history            |
| Inventory reconciliation     | Booking-path drift goes undetected                      |
| Reset-token purge            | Expired rows accumulate; expiry is still checked at use |

Unpausing catches up on the outbox and holds on the next pass. **The missed OTB
snapshots do not come back** — each one is a photograph of a business date that
has passed. That is the cost that grows with every day paused.

> **Running in production again since 2026-08-13.** It was paused from
> 2026-08-11 while the daily failure behind it was diagnosed; the connect
> timeout and the missing retry are both fixed and applied. Verified by
> execution history, not by configuration: the eight most recent runs all
> succeeded, ten minutes apart. See §9.

---

## 2. Networking

Cloud SQL and Memorystore have **no public IP**. Cloud Run reaches them with
**Direct VPC egress** (`network_interfaces` on the service), which replaced the
older Serverless VPC Access connector and removes a managed component from the
stack.

Egress is `PRIVATE_RANGES_ONLY`: traffic to the database and Redis goes through
the VPC, while calls out to OTAs take the normal public path. Routing all
egress through the VPC would need a Cloud NAT we do not otherwise want.

### Custom domain

The dashboard, the apex and www are served by a **global load balancer**
(`loadbalancer.tf`). `api.` keeps its Cloud Run domain mapping.

| Name                 | Serves             | How                        |
| -------------------- | ------------------ | -------------------------- |
| `<domain>` (apex)    | the marketing site | load balancer → GCS bucket |
| `www.<domain>`       | 301 to the apex    | load balancer              |
| `dashboard.<domain>` | the dashboard      | load balancer → Cloud Run  |
| `api.<domain>`       | the API            | Cloud Run domain mapping   |

**Why two mechanisms rather than one.** Cloud Run issues certificates for its
own domain mappings, and for this project it twice did not. `api.` was issued
one within the hour. `app.` never got one and was abandoned; `dashboard.`, a
different name with byte-identical DNS against the same service, sat six hours
presenting no certificate at all while the API reported `CertificatePending`
and retried hourly. There was nothing left to correct on our side — no CAA
record, no proxy, matching A/AAAA/CNAME — so certificate issuance moved to a
load balancer, which reports its state per domain instead of retrying in
silence. `api.` stays where it is because it works.

It costs roughly **$18-25/month** for the forwarding rule and its traffic. It is
also the thing Cloud Armor attaches to, so the rate limiting the public booking
routes still need (`decisions-pending-review.md` §17) now has somewhere to go.

The order matters, and each step fails unhelpfully if the one before it is
skipped:

```bash
# 1. Prove ownership, once per domain. Opens Search Console; ownership is a TXT
#    record. Applies run from a laptop, not CI, so this is your own Google
#    account and no service account needs adding as a co-owner.
#    Already done for deehubhotel.com on 2026-08-12.
gcloud domains verify deehubhotel.com
gcloud domains list-user-verified --project=deehub-hotel

# 2. Build the load balancer. Creates the static IP, the certificate (which
#    starts PROVISIONING), the bucket, and DESTROYS the dashboard's old Cloud
#    Run mapping — which serves nothing anyway.
terraform apply

# 3. Point DNS at it. Three A records to one address, plus api. unchanged.
terraform output custom_domain_dns_records

# 4. Watch the certificate. Per domain, which is the whole point.
eval "$(terraform output -raw lb_certificate_check)"

# 5. Fill the bucket. CI does this on every merge to main; run it by hand the
#    first time rather than waiting for a commit.
gcloud storage rsync apps/marketing \
  "gs://$(terraform output -raw marketing_bucket)" \
  --recursive --delete-unmatched-destination-objects
```

**`PROVISIONING` is normal for 15-60 minutes** after the records go live. A
domain reporting `FAILED_NOT_VISIBLE` is one whose DNS has not moved yet, or
is proxied — that one is on us, and it is the only failure mode here that we
can fix.

**If DNS is behind a proxy** (Cloudflare's orange cloud), turn it off for every
record. A proxied name answers with the proxy's own address, the validator
never reaches ours, and the certificate waits forever.

**During the certificate window the dashboard is only reachable on its run.app
URL**, which is why `cors_origins` names both that URL and the custom domain.
Drop the run.app origin once the domain serves; leaving it is not dangerous,
just untidy.

---

## 3. Secrets

Terraform creates the secret _containers_; the **values are added out of band**
so they never appear in state, in a plan, or in a pull request:

```bash
printf '%s' "$(openssl rand -base64 48)" | \
  gcloud secrets versions add deehub-jwt-access-secret-prod --data-file=-
printf '%s' "$(openssl rand -base64 48)" | \
  gcloud secrets versions add deehub-jwt-refresh-secret-prod --data-file=-
# CREDENTIALS_KEY must decode to exactly 32 bytes (AES-256).
printf '%s' "$(openssl rand -base64 32)" | \
  gcloud secrets versions add deehub-credentials-key-prod --data-file=-
```

`database-url` is the exception: Terraform generates the password and writes
the version itself, so no human ever handles it.

The API refuses to boot in production if it detects a development secret — a
guard that has already fired once during container testing, which is exactly
when you want it to.

### Notification delivery

All optional, and all absent by default:

| Variable             | What it is                                               |
| -------------------- | -------------------------------------------------------- |
| `EMAIL_API_KEY`      | Resend API key. Email is HTTP, not SMTP — see below.     |
| `EMAIL_FROM`         | Verified sender, e.g. `Baan Suan <bookings@example.com>` |
| `LINE_CHANNEL_TOKEN` | LINE Messaging API channel access token                  |
| `LINE_STAFF_TARGET`  | LINE user or group id the staff alerts are pushed to     |

With none of them set, messages are still composed, stored and shown in the
dashboard — marked `SKIPPED` with the reason. Nothing is lost and nothing is
silently pretended to have been sent; setting the variables starts real
delivery with no code change.

**Email must be an HTTP API.** Cloud Run blocks outbound connections on the
SMTP ports, so the hotel's own mail server is not reachable from where this
runs. That is a platform constraint, not a preference.

#### The sending domain is what actually blocks guest email

`EMAIL_API_KEY` is set and mail leaves the building — that much is proved end
to end. What does not work is mail to _anyone else_: with no verified domain,
Resend accepts only `onboarding@resend.dev` as a sender and delivers it only to
the Resend account owner. Every guest confirmation is composed, stored, and
marked failed with the provider's refusal on the row.

This is an account task, not a code one. Nothing in the repository changes:

1. Resend dashboard → **Domains → Add domain** → `deehubhotel.com`.
2. It returns three records — a DKIM `TXT` on a selector subdomain, an SPF
   `TXT`, and an optional `MX` for bounce feedback. The values are generated
   per account and cannot be written down here in advance.
3. Add them at the registrar alongside the Cloud Run CNAMEs. These are TXT and
   MX records on names Cloud Run does not use, so the two sets do not collide.
4. Wait for Resend to report **Verified**, then set the sender and apply:

   ```hcl
   email_from = "DeeHub Hotel <bookings@deehubhotel.com>"
   ```

Use a subdomain (`send.deehubhotel.com`) instead if the domain will also carry
the hotel's own mailboxes one day — a sending reputation earned by a booking
robot is then kept separate from the one your staff mail depends on.

**One thing still stands between a verified domain and a delivered
confirmation:** the maintenance job is what drains the outbox, and it is
paused (§1). Verifying the domain makes delivery possible; unpausing is what
makes it happen.

**Rotating `CREDENTIALS_KEY` is not a drop-in.** It encrypts channel
credentials at rest. The stored format is versioned (`v1:iv:tag:ciphertext`)
precisely so a future key or a move to Cloud KMS envelope encryption can
decrypt old values during rollout, but that migration has to be written before
the key changes.

---

## 4. First-time setup

```bash
# 1. Remote state. Local state means one laptop can destroy production.
gcloud storage buckets create gs://PROJECT-deehub-tfstate --location=asia-southeast1
gcloud storage buckets update gs://PROJECT-deehub-tfstate --versioning

# 2. Infrastructure. The image variables are placeholders on the first apply;
#    CI supplies real ones on every deploy after that.
cd infrastructure/terraform
terraform init -backend-config="bucket=PROJECT-deehub-tfstate"
terraform apply \
  -var project_id=PROJECT \
  -var api_image=gcr.io/cloudrun/placeholder \
  -var web_image=gcr.io/cloudrun/placeholder

# 3. Secret values (section 3) — REQUIRED between the two applies, see below.

# 4. Re-apply. Cloud Run resources can now resolve their secrets.
terraform apply -var project_id=PROJECT \
  -var api_image=gcr.io/cloudrun/placeholder \
  -var web_image=gcr.io/cloudrun/placeholder

# 5. Build and deploy the real images.
./infrastructure/first-deploy.sh

# 6. Create the first organization and owner.
pnpm --filter @deehub/api db:create-org -- \
  --name "Hotel Group" --slug hotel-group \
  --owner owner@hotel.example --property "Hotel Name"
```

### The first apply takes two passes

This is not optional, and it is not a bug to work around:

**Cloud Run refuses to create a service or job whose secret has no version.**
Terraform creates the secret _containers_ but deliberately never their values,
so on a clean project the first apply gets as far as Cloud Run and stops. Run
`set-secrets.sh`, then apply again.

`database-url` is the exception — Terraform generates the password and writes
that version itself — but it depends on Cloud SQL, which depends on the VPC
peering, so it only appears once the network is up.

### Permissions the operator needs

`roles/editor` is not sufficient. Creating the private-services peering also
requires:

- `roles/servicenetworking.networksAdmin`
- `roles/compute.networkAdmin`

and managing IAM, service accounts and secrets requires
`roles/resourcemanager.projectIamAdmin`, `roles/iam.serviceAccountAdmin`,
`roles/iam.workloadIdentityPoolAdmin` and `roles/secretmanager.admin`.

`roles/run.admin` is needed too, and for a less obvious reason: `roles/editor`
can create a Cloud Run service but cannot call `setIamPolicy` on it. Everything
deploys and then the `allUsers` invoker binding that makes the API and dashboard
reachable fails — so the failure lands at the very end of a long apply.

Newly granted roles take up to a minute to propagate. A `PERMISSION_DENIED`
immediately after a grant is usually timing, not the wrong role.

### Point ADC at this project

Terraform authenticates with Application Default Credentials, which carry their
own quota project — and it does **not** follow `gcloud config set project`. On a
machine that has worked on other projects it will still point at whichever one
was configured last, and service networking then fails with a confusing
`UNAUTHENTICATED` (error code 16) rather than a permission error:

```bash
gcloud auth application-default set-quota-project deehub-hotel
```

Worth checking first on any machine that touches more than one GCP project.

### Platform constraints

Two more that the configuration already encodes, noted because the error
messages point somewhere unhelpful:

- **Cloud SQL** defaults new instances to `ENTERPRISE_PLUS`, which rejects
  shared-core tiers. `edition = "ENTERPRISE"` is set explicitly so
  `db-f1-micro` is accepted.
- **Cloud Run injects `PORT`** and refuses a deploy that also sets it. The
  service declares `container_port` and nothing else; the app reads `PORT` from
  the environment Cloud Run provides.

Region is `asia-southeast1` (Singapore) — the closest Google region to Thailand,
and the one that keeps guest data nearest the market it serves.

### Project bootstrap

Run once, before Terraform. Requires an **open** billing account
(`gcloud billing accounts list` — the `OPEN` column must be `True`).

```bash
export PROJECT=deehub-prod          # must be globally unique
export BILLING=XXXXXX-XXXXXX-XXXXXX
export REGION=asia-southeast1

gcloud projects create "$PROJECT" --name="DeeHub Hotel"
gcloud billing projects link "$PROJECT" --billing-account="$BILLING"
gcloud config set project "$PROJECT"

# Terraform enables the rest; these two are needed to create anything at all.
gcloud services enable cloudresourcemanager.googleapis.com iam.googleapis.com
```

A **separate project** rather than an existing one: it makes billing legible,
lets IAM be scoped to this product alone, and means deleting the project is a
complete, reliable teardown.

### GitHub → GCP authentication

CI uses **Workload Identity Federation**, not a service-account key. GitHub
mints a short-lived token per run, so there is no long-lived credential in
repository secrets to leak or rotate.

```bash
export REPO=YOUR_GITHUB_ORG/deehub-hotel
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')

gcloud iam service-accounts create deehub-deployer \
  --display-name="DeeHub CI deployer"
DEPLOYER="deehub-deployer@${PROJECT}.iam.gserviceaccount.com"

# Enough to push images and move Cloud Run traffic — not to read secrets or
# reach the database.
for ROLE in roles/run.admin roles/artifactregistry.writer roles/iam.serviceAccountUser; do
  gcloud projects add-iam-policy-binding "$PROJECT" \
    --member="serviceAccount:${DEPLOYER}" --role="$ROLE" --condition=None
done

gcloud iam workload-identity-pools create github \
  --location=global --display-name="GitHub Actions"

gcloud iam workload-identity-pools providers create-oidc github \
  --location=global --workload-identity-pool=github \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --attribute-condition="assertion.repository=='${REPO}'"

# The attribute condition above is the security boundary: without it ANY
# GitHub repository in the world could mint a token for this service account.
gcloud iam service-accounts add-iam-policy-binding "$DEPLOYER" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github/attribute.repository/${REPO}"

echo "GCP_WORKLOAD_IDENTITY_PROVIDER=projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github/providers/github"
echo "GCP_DEPLOY_SERVICE_ACCOUNT=${DEPLOYER}"
echo "GCP_PROJECT_ID=${PROJECT}"
```

Set those three as repository secrets (Settings → Secrets and variables →
Actions).

| Secret                           | Value                          |
| -------------------------------- | ------------------------------ |
| `GCP_PROJECT_ID`                 | Project id                     |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | Full provider resource name    |
| `GCP_DEPLOY_SERVICE_ACCOUNT`     | Deployer service-account email |

### Prerequisites on the operator's machine

- **Terraform ≥ 1.9** (`terraform version`). The config declares this because
  it uses provider features older releases reject.
- **gcloud** authenticated as a user with project-creation and billing rights.
- A **GitHub remote** — the deploy pipeline runs on GitHub Actions, so the
  repository has to be pushed somewhere before any of it fires.

---

## 5. Deploy pipeline

`.github/workflows/deploy.yml`, on push to `main`:

1. **Verify** — runs the full CI workflow against the exact commit. Deploying
   an untested commit is how a broken booking path reaches production.
2. **Build and push** both images, tagged with the git SHA. Never `:latest` — a
   rollback has to be able to name the precise image that was running.
3. **Migrate** — updates and executes the Cloud Run job, and waits. Migrations
   run _before_ any traffic shifts; if this fails the deploy stops and
   production is untouched.
4. **Deploy** API, worker and dashboard.
5. **Smoke test** — `/health/ready` (not `/health`), because readiness proves
   the new revision can actually reach the database.

Concurrency is pinned to one deploy at a time: two in flight would let the
second shift traffic to an image whose migration had not run.

### Why migrations run as a separate job

Running them from an application container at boot would race across instances
and could half-apply a schema while old code is still serving. A job runs
exactly once, and its failure is visible before any user is affected.

Schema changes follow **expand/contract** (database.md §12): add nullable →
backfill → switch reads → make non-null → drop old. Each deploy is therefore
compatible with the revision it replaces, which is what makes step 3 safe
before step 4 and what makes rollback possible at all.

---

## 6. Rollback

```bash
gcloud run revisions list --service deehub-api-prod --region asia-southeast1
gcloud run services update-traffic deehub-api-prod \
  --region asia-southeast1 --to-revisions REVISION_NAME=100
```

Traffic shifting is instant and does not rebuild anything.

**Rolling back code does not roll back the schema.** Expand/contract is what
makes this safe: the previous revision still works against the new schema. If a
migration itself must be undone, use its documented `down` step, or restore
from point-in-time recovery — which is the reason PITR is enabled.

---

## 7. Monitoring

- **Sentry** is initialised before any other import in both entry points, since
  it instruments modules as they load. `beforeSend` strips request bodies,
  cookies and authorization headers, so a password or passport number cannot
  reach a third party.
- **Cloud Logging** receives structured JSON with the request id, organization
  and property on every line.
- Metrics that matter, from `sync_jobs` and the queues: sync latency
  (target < 60s), queue depth, dead-lettered jobs, and consecutive channel
  failures.

**Alert on these, in priority order:**

1. Any row from the nightly reconciliation job — inventory drift means a bug in
   the booking path and must be looked at the same day.
2. `channel.sync_failed` reaching the dead-letter queue — a stalled sync is the
   failure mode that causes overbookings.
3. `channel.overbooking_detected` — a guest needs moving today.
4. API 5xx rate, readiness failures, Cloud SQL CPU and connection count.

---

## 8. Cost

Estimates for `asia-southeast1`, one small property, at published on-demand
rates. Verify against the [pricing calculator](https://cloud.google.com/products/calculator)
before committing — regional rates move.

### What the current configuration costs

| Item                                                            | Approx./month |
| --------------------------------------------------------------- | ------------- |
| Cloud SQL `db-g1-small`, 20GB SSD, PITR                         | $35–45        |
| Memorystore Basic 1GB                                           | $36           |
| Cloud Run worker — min 1 instance, 1 vCPU, always-allocated CPU | $52           |
| Cloud Run API + dashboard (scale to zero, pilot traffic)        | $1–5          |
| Artifact Registry, storage, logging                             | $3–5          |
| **Total**                                                       | **~$127–143** |

The worker dominates, and that is easy to get wrong. An always-on Cloud Run
instance is billed for every second of the month: 1 vCPU at the
always-allocated rate is 2,592,000 seconds × $0.000018 ≈ **$47 of CPU alone**.
Scale-to-zero services are nearly free by comparison; a `min_instance_count` of
1 is the single most expensive line in the stack.

### Cheaper configurations

**A — Smaller tiers, same architecture. ~$70/month.**

| Change                        | Saves |
| ----------------------------- | ----- |
| Cloud SQL `db-f1-micro`, 10GB | ~$25  |
| Worker to 0.25 vCPU / 256MiB  | ~$39  |

0.6GB of RAM is tight for PostgreSQL but adequate for one or two pilot
properties. Keep PITR: losing a day of bookings costs more than $5 of storage.
No code changes; two variables in `variables.tf`.

**B — Drop Memorystore, queue in PostgreSQL. ~$34/month.**

BullMQ requires Redis, so removing Memorystore means changing queue technology.
The outbox is already a Postgres queue drained with `FOR UPDATE SKIP LOCKED`;
the same pattern covers the ARI and delivery queues, and the Redis dirty-date
set becomes a table.

At pilot volume — a few hundred jobs a day — Postgres is comfortably enough,
and it removes an entire managed service from the stack. Roughly one to two
days of work, and it must not be rushed: the debounce and the drain-during-push
race were subtle enough in Redis to be worth re-testing carefully.

**C — Also make the worker request-driven. ~$20–25/month.**

Scale the worker to zero and wake it with Cloud Tasks (1M free operations per
month) when the outbox is written. Near-instant, and no idle billing.
A larger change: the relay loop becomes a handler, and the sync-latency target
then depends on task delivery rather than on a loop we control.

### Recommendation

Start with **A**, and do **B** before the third property is onboarded. A gets
production running this week for the price of two variables; B halves the bill
again and simplifies the architecture, but is engineering time better spent
after a real hotel is using the system.

Avoid the tempting non-answers: a free-tier hosted Postgres that sleeps is
wrong for a booking system, and Compute Engine's Always Free tier does not
cover Singapore.

### Other levers

- **$300 / 90-day trial credit** on a new billing account covers the whole
  pilot. Worth checking before paying anything.
- **Dev and staging share the production Cloud SQL instance** with separate
  databases rather than a second instance.
- **Delete unused revisions and images.** Artifact Registry bills for storage,
  and every deploy adds two images.

## 9. Known gaps

1. **No staging environment.** `environment` is already a variable, so a second
   workspace is the mechanism; it is simply not stood up yet.
2. **No CDN.** ~~No custom domain.~~ `deehubhotel.com` was registered on
   2026-08-12 and both services answer on it — `api.` and `dashboard.` domain
   mappings exist in production. The apex is deliberately still empty
   (`decisions-pending-review.md` §19).
3. **No self-service signup.** The first organization and owner are seeded by
   hand against production.
4. ~~**Terraform is validated but never applied.**~~ **Resolved.** It has been
   applied since 2026-07-31; a `terraform plan` on 2026-08-13 reported
   `No changes`. What replaced this gap is a subtler one: the plan is run by
   hand, so drift is invisible until somebody looks
   (`decisions-pending-review.md` §18).
5. ~~**Maintenance is paused in production.**~~ **Resolved 2026-08-13.** The
   diagnosis holds and is worth keeping: roughly one run in three died on
   `Connection terminated due to connection timeout` against a shared-core
   `db-f1-micro` with no SLA, and the alert noise is what got the job paused on
   2026-08-11 — taking guest email, hold expiry and the on-the-books snapshot
   with it. Both halves of the fix are in and applied: the pool waits 15s rather
   than 5s (`apps/api/src/database/database.module.ts`) and the scheduler
   retries once, which absorbs a transient connect failure without masking
   inventory drift — drift fails the retry too. Verified from execution history
   on 2026-08-13, not from configuration.
6. **Single region, zonal database.** Accepted for Milestone 1
   (architecture.md §11); regional HA is a tier change when revenue justifies
   it.
