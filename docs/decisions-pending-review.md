# Decisions made without you — please review

Written during an unattended working session on 2026-07-30. Everything here is
a judgement call I made on your behalf because you were away, or something I
could not finish and worked around. Each one is reversible.

---

## 1. Alerts go to chakrit69@gmail.com — and the channel is NOT yet verified

**You must click a link before any alert is delivered.** Google emailed a
confirmation to that address when the notification channel was created; until
it is clicked the channel exists and delivers nothing. An unverified channel is
silent, not queued, so the alerts below are currently decorative.

Check it:

```bash
gcloud beta monitoring channels list --project=deehub-hotel --format=json \
  | grep -i verification
```

I used your own address because it is the only one I had. If alerts should go
to an operations alias instead, change `alert_email` in
`infrastructure/terraform/terraform.tfvars` and re-apply.

## 2. Three alert policies, deliberately not more

- **Maintenance job failed** — the hourly job already exits non-zero on
  inventory drift or a stuck outbox and previously told nobody.
- **API returning 5xx** — sustained for five minutes, so a deploy blip is quiet.
- **Database disk above 85%** — Cloud SQL stops accepting writes when full,
  which presents as "the hotel cannot take a booking".

I stopped at three on purpose. An inbox that alerts on everything is an inbox
nobody opens. If you want more coverage, the obvious next ones are Cloud SQL
CPU and Cloud Run instance count.

## 3. Cloud Error Reporting instead of Sentry, for now

You asked for Sentry (item 1), which needs an account and a DSN I cannot create
for you. Rather than leave production with no error reporting at all, unhandled
errors now emit a structured entry that **Google Cloud Error Reporting** groups
— no signup, no cost, already part of the project.

Sentry is untouched and takes over the moment a DSN exists:

```bash
printf '%s' 'https://YOUR-DSN@sentry.io/123' \
  | gcloud secrets versions add deehub-sentry-dsn-prod --project=deehub-hotel --data-file=-
```

Both can run at once. See errors meanwhile at
**Cloud Console → Error Reporting**.

---

## Still not done, and why

Anything listed here was either out of reach or a decision I judged yours to
make. Nothing is silently missing.

_(Updated as the session continues.)_
