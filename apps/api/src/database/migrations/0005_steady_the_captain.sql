ALTER TABLE "guests" ADD COLUMN "merged_into_id" uuid;--> statement-breakpoint
ALTER TABLE "guests" ADD COLUMN "merged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "guests" ADD CONSTRAINT "guests_merged_into_id_guests_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."guests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guests" ADD CONSTRAINT "guests_merged_ck" CHECK (("guests"."merged_into_id" IS NULL) = ("guests"."merged_at" IS NULL) AND "guests"."merged_into_id" IS DISTINCT FROM "guests"."id");