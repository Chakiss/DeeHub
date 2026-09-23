-- Where a stay's frozen night prices came from, and why a typed price sits
-- below the plan. Additive; existing rows read PROPERTY_RATES, which is what
-- they were.
--
-- ROLLBACK (Definition of Done): reversible.
--   ALTER TABLE reservation_stays DROP CONSTRAINT stays_priced_from_ck;
--   ALTER TABLE reservation_stays DROP COLUMN priced_from, DROP COLUMN price_note;
-- Costs the label and the note; the frozen prices themselves are untouched.

ALTER TABLE "reservation_stays" ADD COLUMN "priced_from" text DEFAULT 'PROPERTY_RATES' NOT NULL;--> statement-breakpoint
ALTER TABLE "reservation_stays" ADD COLUMN "price_note" text;--> statement-breakpoint
ALTER TABLE "reservation_stays" ADD CONSTRAINT "stays_priced_from_ck" CHECK ("reservation_stays"."priced_from" IN ('PROPERTY_RATES','CHANNEL','MANUAL'));