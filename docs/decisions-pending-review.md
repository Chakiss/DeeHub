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

## 6. A channel cannot be activated until every room type is mapped

The channel admin screens are new; before them a channel could only be created
by hand-written SQL. Activation is now refused while any active room type has
no mapping.

This is not tidiness. An active channel with a missing mapping does **not**
fail loudly — the ARI push simply skips that room type, so the OTA keeps
selling whatever availability it last heard, and the first symptom is a guest
arriving at a full hotel.

Two consequences worth knowing:

- Adding a new room type to a property **silently un-satisfies** this rule for
  every active channel. The channel stays ACTIVE (nothing deactivates it) but
  the list screen shows "2 of 3 room types" in amber. I did not auto-deactivate
  — cutting off a live OTA because someone added a room type would be worse.
- `CHANNEL_SYNC_ENABLED` is a separate deployment flag and is currently **off**.
  An ACTIVE channel pushes nothing until it is on. Turning it on is your call:

  ```bash
  # infrastructure/terraform/terraform.tfvars
  enable_channel_sync = true
  ```

## 7. Channel credentials are write-only, including to you

Credentials go in encrypted (AES-256-GCM) and never come back out through the
API, the UI, or the audit trail — the audit entry records only
`credentialsProvided: true`. There is no "show credentials" button and I did not
build one.

If a credential is lost, it is re-entered, not recovered. That is the intended
trade.

## 8. An observed test flake, not yet explained

Running the full API suite once produced a single failure in
`guests.e2e.test.ts` — a `POST /reservations` answered `405 Method Not Allowed`.
It has not reproduced in the runs since (416 tests, green), and the file passes
alone every time.

I am recording it rather than calling it fixed. `405` is a routing-layer answer,
which is odd for what otherwise looks like a shared-database race between
parallel test files. If it reappears in CI, that is the thread to pull.

## 9. The browser suite was stranding a database row on every run

Two bugs found while adding browser coverage for the new screens, both fixed:

- `e2e/fixtures.ts` never deleted the channel tables, so once a test created a
  channel the organization could not be deleted — every foreign key here is
  `ON DELETE RESTRICT`.
- `e2e/global-teardown.ts` wrapped the whole teardown in a bare `catch {}`,
  which was meant to cover "setup never wrote the file" but also swallowed
  "the delete failed". The suite reported green while leaving an organization
  behind. It now reports the failure and rethrows.

Related: the browser specs run **serially against one seeded property**, and
the inventory and reservation specs assert absolute counts on it ("0/5"). Any
spec that BOOKS therefore has to bring its own room type — `booking.spec.ts`
now seeds one via `seedIsolatedRoomType` and removes it afterwards. Adding it
without that quietly broke five existing tests.

## 10. Extending a stay refuses rather than moving anyone's room

A stay already under way can now be extended. It is a separate endpoint, not a
flag on the modification, because the two do opposite things to inventory:
modifying gives the nights back before taking new ones, extending only ever
takes. That is what makes it safe for a guest who is in the building.

Two calls in it are worth your disagreement.

**The assigned room is kept, and a clash refuses the whole extension.** If
another booking holds room 302 on one of the added nights, the API answers 409
naming the room and the booking in the way. The alternative — silently dropping
the assignment, which is what a MODIFICATION does — would leave a guest who is
physically in 302 tonight with no room on the system, discovered at the worst
moment. Someone has to be moved, and that is a decision for the desk.

**Arrival restrictions are not re-checked.** Closed-to-arrival, minimum stay
and maximum stay are evaluated on the night a guest arrives; an extension does
not change that night. Re-running them would refuse a real request because the
first added night is closed to arrival — when nobody is arriving — or because a
max-stay set to shape arrivals is shorter than this guest's new total. Stop-sell
and availability on the added nights, and closed-to-departure on the new date,
all still apply.

**This no longer stands: shortening is built** (item 14), as its own endpoint
for the same reason extending is its own endpoint.

## 11. Notifications are written whether or not they can be delivered

Guests now get a booking confirmation and a cancellation notice; the desk gets
an alert when a channel sells a room. Four decisions in there you may want to
overturn.

**Email needs a provider account, and I could not create one.** Cloud Run
blocks outbound SMTP, so the hotel's own mail server is not reachable from
where this runs — email has to be an HTTPS API. The adapter is written against
**Resend** because it is one POST and a free tier; SendGrid or Mailgun would be
another adapter behind the same port, not a rewrite.

Until `EMAIL_API_KEY` and `EMAIL_FROM` are set, every message is composed,
rendered, stored and marked **"not sent"** with the reason, and the dashboard
shows the full text. This is the same call as Sentry: build the thing, leave
the account to you, and make the gap visible rather than invisible. The
alternative — not building it until someone signs up — leaves you with nothing
to look at and no idea what a guest would have been told.

**LINE is for staff, not guests.** A push needs the recipient's LINE user id,
which only exists once that person has added the hotel's official account. A
guest who booked by phone has not, and nothing in DeeHub collects one. Staff
have: one `LINE_STAFF_TARGET` reaches the group the desk already watches.

**Thai or English by the PROPERTY's country, not the guest's.** DeeHub does
not know a guest's language — nothing in the booking path asks — and guessing
from a name or an email domain would be worse than a consistent default. When
the booking engine starts collecting it, `localeFor()` is the one place that
changes.

**A modification tells the guest nothing.** "Your booking has changed" is only
useful if it says WHAT changed, and the event carries affected dates rather
than a before-and-after a guest could read. Sending a vague one would teach
people to ignore the confirmations too. Say so if you disagree — the hook is
there, commented, in the relay.

**One knock-on you are paying for:** the maintenance job now sends as well as
composes, so its schedule is how long a guest waits. I moved it from hourly to
every ten minutes (`maintenance_schedule` in Terraform). That is 144 Cloud Run
job runs a day instead of 24 — still inside the free tier, but it is your
money and the number is easy to change.

## 12. Self-service password reset — five calls you may want to overturn

`POST /auth/forgot-password` and `POST /auth/reset-password` exist now that
there is a mail provider. Five decisions in there are judgement, not necessity.

**The reset link is NOT written to the notification log.** Every other message
this system sends is stored with its rendered body and shown on the delivery-log
screen to anyone holding `notification:read` — which today includes READ_ONLY,
by the same blanket `:read` rule as item 4. A reset link on that screen is an
account takeover: a front-desk clerk requests one for the owner, reads it out of
the dashboard, and sets a password. So this one message is sent straight down
the sender port and never stored. The cost is that a reset email does not appear
in the log at all; the audit trail records that one was requested, and nothing
records what it said.

**Completing a reset does not sign you in.** You land back at the sign-in screen
with the password you just chose, and the organization slug carried over. Auto
sign-in is friendlier and I did not do it, because a link that arrives by email
should be good for exactly the one thing the person expected and nothing more.
Say so if you disagree — it is a small change in
`complete-password-reset.usecase.ts`.

**The endpoint is deliberately slow.** Every request waits out a 1.2-second
floor whether or not the account exists, because the work for a real account —
a token insert plus an HTTPS call to Resend — is otherwise a timing oracle for
the answer the response body is careful not to give. If a locked-out person
complains the button feels sluggish, that is why, and it is worth keeping.

**Three links per account per fifteen minutes, silently.** Over the limit,
nothing is sent and nothing is said. This is mailbox protection, not brute-force
protection — a 256-bit token is not guessable — and telling the caller they hit
a limit would confirm the account exists.

**A link points wherever `ADMIN_WEB_URL` says.** `cors_origins` is empty in your
Terraform, so there is nothing to fall back to: **in production the API now
refuses to send a reset link at all until `admin_web_url` is set**, rather than
mailing everyone a link to localhost. It is a two-pass bootstrap because
Terraform cannot resolve a cycle between the two Cloud Run services:

```bash
cd infrastructure/terraform
terraform output dashboard_url        # or your custom domain
# put it in terraform.tfvars as admin_web_url = "https://..."
terraform apply
```

Until you do, self-service recovery is built but inert in production, and the
operator-driven reset remains the working path. It logs the reason loudly on
every attempt.

## 13. A second unexplained test flake

While running the full API suite, `password-reset.e2e.test.ts` failed once with
`Parse Error: Expected HTTP/` from supertest, on a case that has passed every
run since — twenty-odd runs of the file alone and two full-suite runs, all
green. Recorded rather than called fixed, same as item 8. Two different files
now, two different unexplained shapes, both looking like something in the shared
test process rather than the code under test. If a third appears, the suite's
process model is the thread to pull, not the individual test.

## 14. Early departure charges nothing, and a hotelier will expect it to

A guest can now leave early: `POST .../stays/{sid}/shorten` releases the nights
they are not staying and takes them off the bill. Both directions sit behind one
"Change departure date" control on the booking, because at the desk it is one
question.

**No fee is charged, and that is the decision you may want to overturn.** Most
hotels charge something for early departure — a night, or the whole balance on a
non-refundable rate. This charges nothing, not as a view on what hotels should
do, but because a penalty has to be POSTED somewhere and the folio does not
exist yet. A fee with nowhere to land would mean inventing a second ledger
nobody can see, which is worse than the gap. The desk takes payment for what the
guest owes, which is what it does today anyway.

The audit entry records `earlyDepartureFeeMinor: 0` on every shortening, so when
the folio arrives the reconciliation between the two is a lookup rather than a
guess about what this operation used to do. The screen says out loud that no fee
was charged, so nobody discovers it from a monthly report.

**Two refusals worth knowing.** Shortening to zero nights is refused and points
at cancellation instead — a zero-night booking holds no inventory, appears on no
night, and nobody ever closes it. Moving check-out to a date already past is
refused rather than clamped: "check them out as of yesterday" is usually a
correction of something else, and silently keeping the slept nights would leave
a booking whose dates disagree with what happened in the building.

_(Updated as the session continues.)_
