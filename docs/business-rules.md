# Business rules

Rules the founder has decided that code and copy must agree on. Each entry names
where it is enforced.

## Cancellation policy

- **Per rate plan.** `rate_plans.is_refundable` is the on/off switch. Off means
  non-refundable: no policy is shown and guests read "Non-refundable". On means
  the plan's `cancellation_notice_hours` (0-720, default 24) and
  `cancellation_refund_percent` (0-100, default 50) apply.
- **The rule.** Cancelling at least `notice_hours` before check-in refunds
  `refund_percent` of the **whole booking total**; cancelling later, or a
  no-show, refunds nothing.
- **The deadline** is the property's check-in time (`properties.check_in_time`,
  default 14:00) on the check-in date, in the property's timezone
  (`properties.timezone`), minus `notice_hours`. Cancelling exactly at the
  deadline is in time (`now <= deadline`). One pure function computes it:
  `booking-engine/domain/cancellation-deadline.ts`.
- **Frozen at booking.** For every source except `OTA` and `TRAVEL_AGENT`, the
  plan's two values are copied onto each `reservation_stays` row when the
  booking is made (a non-refundable plan freezes `0 / 0`). A later edit to the
  plan, or a modification of the stay, never changes them. OTA and travel-agent
  bookings store `NULL`: their terms are the channel's, not ours. So do bookings
  made before this rule existed.
- **What is frozen, and what is not.** Only `notice_hours` and `refund_percent`
  are stored on the stay. The deadline is derived each time from the property's
  **current** check-in time, timezone and the stay's check-in date, so changing
  the property's check-in time moves the deadline of existing bookings.
- **A booking with several stays** (different rate plans) is held to the
  **strictest** terms among them: lowest refund percent wins, ties go to the
  longest notice, and if any stay has no recorded policy the booking has none
  (`strictestPolicy`). The site, the API and the guest email all use that one
  function.
- **Changing a stay's rate plan** (modify) re-freezes the terms from the new
  plan, by the same rules; modifying dates or occupancy on the same plan leaves
  them alone.
- **Accepted for the pilot: what was shown can differ from what is frozen.**
  The policy frozen is the plan's value at the moment the booking is POSTed. A
  plan edited between the search and the booking, or a deadline that passes
  while the guest fills in the form, can therefore differ from what the rooms
  page showed. This is the same class of gap as the price snapshot and is
  accepted for now.
- **Shown truthfully.** The booking site states the policy beside each rate
  ("Cancel 24h+ ahead for a 50% refund"), and "No refund once booked" when the
  deadline has already passed (a room for tonight). The pay page, the
  confirmation page and the guest confirmation email repeat the frozen terms.
- **Google Hotels.** Its `Refundable` flag means fully refundable, so we send it
  only for a refundable plan at 100%.
- **Not yet built (phase B).** Cancelling does not yet compute or post a refund;
  the desk still decides and records it by hand.
