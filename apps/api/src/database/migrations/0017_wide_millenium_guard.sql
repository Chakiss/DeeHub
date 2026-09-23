-- One attempt to pay for a booking online. A folio payment is money that
-- arrived; this is the step before it — a charge started with the provider
-- that may still be waiting on a bank (3-D Secure) or on a guest scanning a
-- PromptPay QR. The provider's charge id is unique so a webhook delivered
-- twice settles once. Additive.
--
-- ROLLBACK (Definition of Done): reversible.
--   DROP TABLE payment_intents;
-- Costs the record of attempts; settled money is on folio_payments and stays.

CREATE TABLE "payment_intents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"reservation_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_charge_id" text NOT NULL,
	"method" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"authorize_uri" text,
	"qr_image_uri" text,
	"failure_reason" text,
	"expires_at" timestamp with time zone,
	"checked_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_intents_method_ck" CHECK ("payment_intents"."method" IN ('CARD','PROMPTPAY')),
	CONSTRAINT "payment_intents_status_ck" CHECK ("payment_intents"."status" IN ('PENDING','PAID','FAILED','EXPIRED')),
	CONSTRAINT "payment_intents_amount_ck" CHECK ("payment_intents"."amount_minor" > 0)
);
--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_intents_provider_charge_uq" ON "payment_intents" USING btree ("provider","provider_charge_id");--> statement-breakpoint
CREATE INDEX "payment_intents_reservation_idx" ON "payment_intents" USING btree ("reservation_id","created_at");--> statement-breakpoint
CREATE INDEX "payment_intents_pending_idx" ON "payment_intents" USING btree ("expires_at") WHERE "payment_intents"."status" = 'PENDING';