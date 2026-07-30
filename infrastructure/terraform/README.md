# DeeHub infrastructure

Terraform for Google Cloud. Full runbook: [docs/deployment.md](../../docs/deployment.md).

## Bootstrap status (project `deehub-hotel`)

| Step                                          | State                                                               |
| --------------------------------------------- | ------------------------------------------------------------------- |
| Project created and billing linked            | done                                                                |
| Terraform state bucket `deehub-hotel-tfstate` | done — versioned, public access blocked                             |
| Deployer service account `deehub-deployer`    | done — `run.admin`, `artifactregistry.writer`, `serviceAccountUser` |
| Workload Identity **pool** `github`           | done                                                                |
| Workload Identity **provider**                | **pending — needs the GitHub repository path**                      |
| `terraform apply`                             | not yet run                                                         |

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

## A note on IAM propagation

Newly granted roles can take up to a minute to take effect. A
`PERMISSION_DENIED` immediately after a grant is usually propagation, not a
wrong role — wait and retry before changing anything.
