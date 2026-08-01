CREATE TABLE "otb_snapshots" (
	"organization_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"as_of" date NOT NULL,
	"room_type_id" uuid NOT NULL,
	"stay_date" date NOT NULL,
	"rooms_sold" integer NOT NULL,
	"revenue_minor" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "otb_snapshots_property_id_as_of_room_type_id_stay_date_pk" PRIMARY KEY("property_id","as_of","room_type_id","stay_date")
);
--> statement-breakpoint
ALTER TABLE "otb_snapshots" ADD CONSTRAINT "otb_snapshots_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "otb_snapshots" ADD CONSTRAINT "otb_snapshots_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "otb_snapshots" ADD CONSTRAINT "otb_snapshots_room_type_id_room_types_id_fk" FOREIGN KEY ("room_type_id") REFERENCES "public"."room_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "otb_snapshots_stay_idx" ON "otb_snapshots" USING btree ("property_id","stay_date","as_of");