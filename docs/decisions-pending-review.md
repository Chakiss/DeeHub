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

## 4. The audit trail is readable by every role, including READ_ONLY

`audit:read` is granted by a blanket rule — READ_ONLY receives every
capability ending in `:read` — so shipping the viewer means a front-desk clerk
can see who changed which rates and whose role was changed.

I did **not** narrow it. Changing the role bundles affects existing users and
is a permissions decision, not a side effect of adding a screen. Most of what
the trail shows (guests, rates, bookings) is already visible on other screens
to the same people; the genuinely new exposure is team administration.

To restrict it to Admin and Owner, remove `audit:read` from the blanket
`:read` rule in `apps/api/src/modules/auth/domain/capabilities.ts` and add it
explicitly to `ADMIN_CAPABILITIES`.

## 5. Modifying a booking is refused once the stay has begun

You can change a booking's dates, room type, rate plan or occupancy — but only
while every night is still in the future. The moment the first night is
consumed, the API refuses with "A stay that has already begun cannot be
modified".

The reason is the same one cancellation follows (domain-model.md §3.5):
modifying releases the old nights back into availability, and releasing a night
a guest actually slept in would retroactively claim the hotel had a room free
when it did not. Occupancy reports and OTA availability would both be wrong.

**What this costs you:** extending a stay for a guest already in-house — a real
and common front-desk request — is not possible yet. It needs its own use case
that only ever ADDS nights and never releases one, which is a different
operation with different rules, not a flag on this one.

Also deliberate: a modification **clears the room assignment** whenever the
dates or the room type change. The assigned room may now be occupied by someone
else on the new nights, and the database's exclusion constraint would reject
the write with an unreadable error rather than a usable message. The API says
so in the response (`roomAssignmentCleared`) and the screen shows it.

_(Updated as the session continues.)_
