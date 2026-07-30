ALTER TABLE "reservations" ADD COLUMN "checked_in_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "checked_out_at" timestamp with time zone;