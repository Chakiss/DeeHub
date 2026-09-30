ALTER TABLE "reservation_stay_nights" ADD COLUMN "released_at" timestamp with time zone;--> statement-breakpoint
-- Backfill. Reconciliation only reads nights from current_date - 1 onward, so
-- older rows being approximate is fine; what matters is that nights already
-- handed back before this migration do not start counting as held.
-- Expired holds released every night.
UPDATE "reservation_stay_nights" n
   SET "released_at" = r."updated_at"
  FROM "reservations" r
 WHERE r."id" = n."reservation_id" AND r."status" = 'EXPIRED';
--> statement-breakpoint
-- Cancellations released the nights on or after the property's business date at
-- the moment of cancelling; earlier nights were retained.
UPDATE "reservation_stay_nights" n
   SET "released_at" = COALESCE(r."cancelled_at", r."updated_at")
  FROM "reservations" r
  JOIN "properties" p ON p."id" = r."property_id"
 WHERE r."id" = n."reservation_id"
   AND r."status" = 'CANCELLED'
   AND n."date" >= (COALESCE(r."cancelled_at", r."updated_at") AT TIME ZONE p."timezone")::date;
--> statement-breakpoint
-- Early check-out already flagged these nights as given back.
UPDATE "reservation_stay_nights" n
   SET "released_at" = r."updated_at"
  FROM "reservations" r
 WHERE r."id" = n."reservation_id" AND n."released_early" = true AND n."released_at" IS NULL;
