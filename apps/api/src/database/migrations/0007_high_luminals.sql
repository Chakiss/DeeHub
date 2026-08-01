CREATE TABLE "folio_charges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"reservation_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"description" text,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"taxable" boolean DEFAULT true NOT NULL,
	"business_date" date NOT NULL,
	"posted_by_user_id" uuid,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_reason" text,
	"voided_by_user_id" uuid,
	CONSTRAINT "folio_charges_amount_ck" CHECK ("folio_charges"."amount_minor" > 0),
	CONSTRAINT "folio_charges_kind_ck" CHECK ("folio_charges"."kind" IN ('FOOD_AND_BEVERAGE','MINIBAR','LAUNDRY','TRANSFER','LATE_CHECKOUT','DAMAGE','OTHER')),
	CONSTRAINT "folio_charges_void_ck" CHECK (("folio_charges"."voided_at" IS NULL) = ("folio_charges"."voided_reason" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "folio_payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"reservation_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"method" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"reference" text,
	"business_date" date NOT NULL,
	"recorded_by_user_id" uuid,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_reason" text,
	"voided_by_user_id" uuid,
	CONSTRAINT "folio_payments_amount_ck" CHECK ("folio_payments"."amount_minor" > 0),
	CONSTRAINT "folio_payments_kind_ck" CHECK ("folio_payments"."kind" IN ('PAYMENT','REFUND')),
	CONSTRAINT "folio_payments_method_ck" CHECK ("folio_payments"."method" IN ('CASH','CARD','BANK_TRANSFER','PROMPTPAY','OTA_COLLECT','CITY_LEDGER')),
	CONSTRAINT "folio_payments_void_ck" CHECK (("folio_payments"."voided_at" IS NULL) = ("folio_payments"."voided_reason" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "folio_charges" ADD CONSTRAINT "folio_charges_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folio_charges" ADD CONSTRAINT "folio_charges_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folio_charges" ADD CONSTRAINT "folio_charges_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folio_charges" ADD CONSTRAINT "folio_charges_posted_by_user_id_users_id_fk" FOREIGN KEY ("posted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folio_charges" ADD CONSTRAINT "folio_charges_voided_by_user_id_users_id_fk" FOREIGN KEY ("voided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folio_payments" ADD CONSTRAINT "folio_payments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folio_payments" ADD CONSTRAINT "folio_payments_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folio_payments" ADD CONSTRAINT "folio_payments_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folio_payments" ADD CONSTRAINT "folio_payments_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folio_payments" ADD CONSTRAINT "folio_payments_voided_by_user_id_users_id_fk" FOREIGN KEY ("voided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "folio_charges_reservation_idx" ON "folio_charges" USING btree ("reservation_id","posted_at");--> statement-breakpoint
CREATE INDEX "folio_charges_business_date_idx" ON "folio_charges" USING btree ("property_id","business_date");--> statement-breakpoint
CREATE INDEX "folio_payments_reservation_idx" ON "folio_payments" USING btree ("reservation_id","recorded_at");--> statement-breakpoint
CREATE INDEX "folio_payments_business_date_idx" ON "folio_payments" USING btree ("property_id","business_date");