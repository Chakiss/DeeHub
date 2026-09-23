-- Google Hotels as a channel (GOOGLE_HOTEL), and ari_sync_requests: the
-- pushes a deployment without Redis owes its channels, drained by the
-- maintenance job on its schedule. Additive; the CHECK is widened in place.
--
-- ROLLBACK (Definition of Done): reversible while no GOOGLE_HOTEL row exists.
--   DROP TABLE ari_sync_requests;
--   ALTER TABLE channels DROP CONSTRAINT channels_type_ck;
--   ALTER TABLE channels ADD CONSTRAINT channels_type_ck CHECK (type IN
--     ('MOCK_OTA','AGODA','BOOKING_COM','EXPEDIA','TRIP_COM','AIRBNB','DIRECT'));

CREATE TABLE "ari_sync_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"room_type_id" uuid NOT NULL,
	"date_from" date NOT NULL,
	"date_to" date NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"last_error" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"pushed_at" timestamp with time zone,
	CONSTRAINT "ari_sync_requests_status_ck" CHECK ("ari_sync_requests"."status" IN ('PENDING','PUSHED','ABANDONED')),
	CONSTRAINT "ari_sync_requests_dates_ck" CHECK ("ari_sync_requests"."date_to" >= "ari_sync_requests"."date_from")
);
--> statement-breakpoint
ALTER TABLE "channels" DROP CONSTRAINT "channels_type_ck";--> statement-breakpoint
ALTER TABLE "ari_sync_requests" ADD CONSTRAINT "ari_sync_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ari_sync_requests" ADD CONSTRAINT "ari_sync_requests_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ari_sync_requests" ADD CONSTRAINT "ari_sync_requests_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ari_sync_requests" ADD CONSTRAINT "ari_sync_requests_room_type_id_room_types_id_fk" FOREIGN KEY ("room_type_id") REFERENCES "public"."room_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ari_sync_requests_pending_idx" ON "ari_sync_requests" USING btree ("channel_id","room_type_id","requested_at") WHERE "ari_sync_requests"."status" = 'PENDING';--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_type_ck" CHECK ("channels"."type" IN ('MOCK_OTA','AGODA','BOOKING_COM','EXPEDIA','TRIP_COM','AIRBNB','DIRECT','GOOGLE_HOTEL'));