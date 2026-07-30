-- Hand-authored: an EXCLUDE constraint cannot be expressed in the Drizzle
-- schema, so drizzle-kit will never generate this. Re-running `db:generate`
-- must not drop it.
--
-- Two stays may not hold the same physical room on overlapping nights. The
-- application checks this too, but the check and the write cannot be made
-- atomic against a concurrent assignment without locking the room — and the
-- same reasoning that put the overbooking guarantee in the database applies
-- here: the front desk finds out at check-in, when the guest is standing there.
--
-- daterange is [check_in, check_out) — a departure and an arrival on the same
-- day are NOT an overlap, which is exactly how hotel nights work.
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
ALTER TABLE "reservation_stays"
  ADD CONSTRAINT "reservation_stays_room_no_overlap"
  EXCLUDE USING gist (
    "assigned_room_id" WITH =,
    daterange("check_in", "check_out", '[)') WITH &&
  )
  -- Unassigned stays are unconstrained: NULL is "no room yet", not a room.
  WHERE ("assigned_room_id" IS NOT NULL);
