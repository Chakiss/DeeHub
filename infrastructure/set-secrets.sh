#!/usr/bin/env bash
#
# Populates Secret Manager after `terraform apply`.
#
# Terraform creates the secret CONTAINERS but never their values, so no
# credential ever lands in Terraform state, a plan, or a pull request. This
# script generates them locally and writes them straight to GCP — the values are
# never printed, and never touch the repository.
#
# Idempotent: re-running adds a new version only for secrets that have none.
# Rotating a secret is a deliberate act, not a side effect of re-running setup.
#
#   ./infrastructure/set-secrets.sh [prod]
set -euo pipefail

ENVIRONMENT="${1:-prod}"
PROJECT="${GCP_PROJECT:-deehub-hotel}"

have_version() {
  gcloud secrets versions list "$1" --project="$PROJECT" --limit=1 --format='value(name)' 2>/dev/null | grep -q .
}

set_generated() {
  local secret="deehub-$1-${ENVIRONMENT}" bytes="$2"
  if have_version "$secret"; then
    echo "  $secret — already set, leaving alone"
    return
  fi
  # openssl writes straight into gcloud; the value never reaches the terminal,
  # the shell history, or a file.
  openssl rand -base64 "$bytes" | tr -d '\n' |
    gcloud secrets versions add "$secret" --project="$PROJECT" --data-file=- >/dev/null
  echo "  $secret — generated ($bytes bytes)"
}

echo "Populating secrets for '$ENVIRONMENT' in $PROJECT"

# 48 bytes of entropy for signing keys; the API also enforces a 32-char minimum.
set_generated jwt-access-secret 48
set_generated jwt-refresh-secret 48

# MUST decode to exactly 32 bytes: it is the AES-256 key for channel
# credentials. `openssl rand -base64 32` produces exactly that.
set_generated credentials-key 32

# Optional. Secret Manager rejects an empty payload and Cloud Run refuses to
# start a container whose secret has no version, so an unconfigured Sentry gets
# the literal "disabled" — which the app treats as off because it is not a URL.
SENTRY_SECRET="deehub-sentry-dsn-${ENVIRONMENT}"
if have_version "$SENTRY_SECRET"; then
  echo "  $SENTRY_SECRET — already set, leaving alone"
else
  printf '%s' "${SENTRY_DSN:-disabled}" |
    gcloud secrets versions add "$SENTRY_SECRET" --project="$PROJECT" --data-file=- >/dev/null
  echo "  $SENTRY_SECRET — ${SENTRY_DSN:+set from \$SENTRY_DSN}${SENTRY_DSN:-placeholder (Sentry off)}"
fi

# Sending credentials, the same placeholder trick as Sentry: an unconfigured
# channel gets the literal "disabled", which the API's config layer treats as
# "not set" rather than as a key it should try to send with.
set_optional() {
  local secret="deehub-$1-${ENVIRONMENT}" value="$2" label="$3"
  if have_version "$secret"; then
    echo "  $secret — already set, leaving alone"
    return
  fi
  printf '%s' "${value:-disabled}" |
    gcloud secrets versions add "$secret" --project="$PROJECT" --data-file=- >/dev/null
  echo "  $secret — ${value:+set from \$$label}${value:-placeholder (off)}"
}

set_optional email-api-key "${EMAIL_API_KEY:-}" EMAIL_API_KEY
set_optional line-channel-token "${LINE_CHANNEL_TOKEN:-}" LINE_CHANNEL_TOKEN

# database-url is written by Terraform itself: it generates the password, so no
# human ever handles it.
echo "  deehub-database-url-${ENVIRONMENT} — managed by Terraform"

echo
echo "Verify (never prints values):"
echo "  gcloud secrets list --project=$PROJECT --filter='name~deehub-'"
