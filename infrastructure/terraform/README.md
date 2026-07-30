# DeeHub infrastructure

Terraform for Google Cloud. Full runbook: [docs/deployment.md](../../docs/deployment.md).

## Bootstrap status (project `deehub-hotel`)

| Step                                          | State                                                               |
| --------------------------------------------- | ------------------------------------------------------------------- |
| Project created and billing linked            | done                                                                |
| Terraform state bucket `deehub-hotel-tfstate` | done — versioned, public access blocked                             |
| Deployer service account `deehub-deployer`    | done — `run.admin`, `artifactregistry.writer`, `serviceAccountUser` |
| Workload Identity **pool** `github`           | done                                                                |
| Workload Identity **provider**                | done — pinned to `Chakiss/DeeHub`                                   |
| `terraform apply`                             | done — 47 resources, `plan` clean                                   |
| GitHub repository secrets                     | **pending — the three below must be set by hand**                   |

## Running it

```bash
terraform init -backend-config=backend.hcl
cp terraform.tfvars.example terraform.tfvars   # then edit
terraform plan
terraform apply
```

Requires Terraform >= 1.9. Homebrew's core formula is frozen at 1.5.7 because
of the BUSL licence change; install from HashiCorp's tap instead:

```bash
brew uninstall terraform && brew install hashicorp/tap/terraform
```

## Finishing the CI identity

The provider pins which repository may mint tokens. That attribute condition is
the entire security boundary — without it, **any** GitHub repository could
authenticate as the deployer — so it is not created until the repository path
is known.

```bash
export REPO=YOUR_ORG/YOUR_REPO
export PROJECT=deehub-hotel
PROJECT_NUMBER=241535067762
DEPLOYER="deehub-deployer@${PROJECT}.iam.gserviceaccount.com"

gcloud iam workload-identity-pools providers create-oidc github \
  --location=global --workload-identity-pool=github --project="$PROJECT" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --attribute-condition="assertion.repository=='${REPO}'"

gcloud iam service-accounts add-iam-policy-binding "$DEPLOYER" \
  --project="$PROJECT" --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github/attribute.repository/${REPO}"
```

Then set these as GitHub repository secrets:

| Secret                           | Value                                                                                  |
| -------------------------------- | -------------------------------------------------------------------------------------- |
| `GCP_PROJECT_ID`                 | `deehub-hotel`                                                                         |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | `projects/241535067762/locations/global/workloadIdentityPools/github/providers/github` |
| `GCP_DEPLOY_SERVICE_ACCOUNT`     | `deehub-deployer@deehub-hotel.iam.gserviceaccount.com`                                 |

## Two traps worth knowing

**ADC quota project.** Terraform uses Application Default Credentials, which do
not follow `gcloud config set project`. If yours points elsewhere, creating the
private-services peering fails with `UNAUTHENTICATED` (code 16), which reads
like an auth problem rather than a configuration one:

```bash
gcloud auth application-default set-quota-project deehub-hotel
```

**The first apply needs two passes.** Cloud Run will not create a service or
job whose secret has no version, and Terraform deliberately never writes secret
values. Apply, run `../set-secrets.sh`, apply again.

## Platform constraints this configuration encodes

Each of these cost a failed apply to discover:

| Constraint                                                                                      | Why the config looks the way it does                                                                |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Cloud SQL defaults new instances to **ENTERPRISE_PLUS**, which rejects shared-core tiers        | `edition = "ENTERPRISE"` is set explicitly, or `db-f1-micro` fails with "Invalid Tier for Edition"  |
| Cloud Run **injects `PORT`** and rejects it as an explicit env var                              | The API service sets `container_port` only                                                          |
| Cloud Run will not start a container whose **secret has no version**                            | Hence the two-pass first apply                                                                      |
| `secret_key_ref` names the secret **container**, so the version is not an implicit dependency   | Every Cloud Run resource `depends_on` the `database_url` version, or a fresh apply races and fails  |
| Secret Manager **rejects an empty payload**                                                     | An unconfigured Sentry stores `disabled`; the app treats a non-URL as off                           |
| VPC peering needs more than `roles/editor`                                                      | `servicenetworking.networksAdmin` + `compute.networkAdmin`                                          |
| ADC's quota project is separate from `gcloud config`                                            | Wrong one gives `UNAUTHENTICATED`, not a permission error                                           |
| `roles/editor` can create a Cloud Run service but not set its IAM policy                        | Making the api and dashboard public needs `roles/run.admin` as well                                 |
| Artifact Registry has **immutable tags**, and a BuildKit attestation index writes the tag twice | Images are built `--provenance=false --sbom=false`, or the push fails after the image has landed    |
| Terraform must not own the container **image**                                                  | `ignore_changes` on all five, or the next apply reverts production to the placeholder               |
| An env var set to `""` is not the same as an unset one                                          | `REDIS_URL` is omitted entirely when `enable_channel_sync = false`; empty made the API fail to boot |

## A note on IAM propagation

Newly granted roles can take up to a minute to take effect. A
`PERMISSION_DENIED` immediately after a grant is usually propagation, not a
wrong role — wait and retry before changing anything.
