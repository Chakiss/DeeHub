-- What a guest sees before they book: the property's blurb, coordinates and
-- website (which Google matches a listing on), a room type's bed and size,
-- and photos for both. Plus one commercial switch — rate_plans.sell_online —
-- so a desk-only rate never becomes the lowest price a stranger is shown.
-- Everything is additive; every new column is nullable or defaulted.
--
-- ROLLBACK (Definition of Done): reversible.
--   DROP TABLE media;
--   ALTER TABLE properties DROP CONSTRAINT properties_latitude_ck,
--     DROP CONSTRAINT properties_longitude_ck,
--     DROP COLUMN website, DROP COLUMN latitude, DROP COLUMN longitude,
--     DROP COLUMN description_th, DROP COLUMN description_en, DROP COLUMN amenities;
--   ALTER TABLE rate_plans DROP COLUMN sell_online;
--   ALTER TABLE room_types DROP CONSTRAINT room_types_size_ck,
--     DROP COLUMN description_th, DROP COLUMN bed_config, DROP COLUMN size_sqm;
-- Costs the photos' rows (the objects stay in the bucket) and the copy.

CREATE TABLE "media" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"room_type_id" uuid,
	"object_key" text NOT NULL,
	"content_type" text NOT NULL,
	"bytes" integer NOT NULL,
	"width" integer,
	"height" integer,
	"alt" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_kind_ck" CHECK ("media"."kind" IN ('PROPERTY','ROOM_TYPE')),
	CONSTRAINT "media_room_type_ck" CHECK (("media"."kind" = 'ROOM_TYPE' AND "media"."room_type_id" IS NOT NULL) OR ("media"."kind" = 'PROPERTY' AND "media"."room_type_id" IS NULL)),
	CONSTRAINT "media_bytes_ck" CHECK ("media"."bytes" > 0)
);
--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "website" text;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "latitude" numeric(9, 6);--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "longitude" numeric(9, 6);--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "description_th" text;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "description_en" text;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "amenities" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "rate_plans" ADD COLUMN "sell_online" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "room_types" ADD COLUMN "description_th" text;--> statement-breakpoint
ALTER TABLE "room_types" ADD COLUMN "bed_config" text;--> statement-breakpoint
ALTER TABLE "room_types" ADD COLUMN "size_sqm" smallint;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_room_type_id_room_types_id_fk" FOREIGN KEY ("room_type_id") REFERENCES "public"."room_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "media_object_key_uq" ON "media" USING btree ("object_key");--> statement-breakpoint
CREATE INDEX "media_property_kind_idx" ON "media" USING btree ("property_id","kind","room_type_id","sort_order");--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_latitude_ck" CHECK ("properties"."latitude" IS NULL OR "properties"."latitude" BETWEEN -90 AND 90);--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_longitude_ck" CHECK ("properties"."longitude" IS NULL OR "properties"."longitude" BETWEEN -180 AND 180);--> statement-breakpoint
ALTER TABLE "room_types" ADD CONSTRAINT "room_types_size_ck" CHECK ("room_types"."size_sqm" IS NULL OR "room_types"."size_sqm" > 0);