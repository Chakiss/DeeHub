-- Early check-out frees the ROOM, not only the inventory.
--
-- room_released_on is the morning the physical room came free when that is
-- before check-out; null means held to check-out. The room-overlap guard from
-- 0001 is restated on COALESCE(room_released_on, check_out) so a room a guest
-- has walked out of can be given to the next guest the same day, while the
-- booking's own dates and money stay exactly as taken. Equal to check_in for a
-- day use: the range is then empty and blocks nothing.
--
-- ROLLBACK (Definition of Done):
--   ALTER TABLE reservation_stays DROP CONSTRAINT reservation_stays_room_no_overlap;
--   ALTER TABLE reservation_stays ADD CONSTRAINT reservation_stays_room_no_overlap
--     EXCLUDE USING gist (assigned_room_id WITH =, daterange(check_in, check_out, '[)') WITH &&)
--     WHERE (assigned_room_id IS NOT NULL);
--   ALTER TABLE reservation_stays DROP CONSTRAINT stays_room_released_ck;
--   ALTER TABLE reservation_stays DROP COLUMN room_released_on;

ALTER TABLE "reservation_stays" ADD COLUMN "room_released_on" date;--> statement-breakpoint
ALTER TABLE "reservation_stays" ADD CONSTRAINT "stays_room_released_ck" CHECK ("reservation_stays"."room_released_on" IS NULL OR ("reservation_stays"."room_released_on" >= "reservation_stays"."check_in" AND "reservation_stays"."room_released_on" <= "reservation_stays"."check_out"));--> statement-breakpoint
ALTER TABLE "reservation_stays" DROP CONSTRAINT "reservation_stays_room_no_overlap";--> statement-breakpoint
ALTER TABLE "reservation_stays"
  ADD CONSTRAINT "reservation_stays_room_no_overlap"
  EXCLUDE USING gist (
    "assigned_room_id" WITH =,
    daterange("check_in", COALESCE("room_released_on", "check_out"), '[)') WITH &&
  )
  WHERE ("assigned_room_id" IS NOT NULL);
