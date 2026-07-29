CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"plan" text DEFAULT 'TRIAL' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_status_ck" CHECK ("organizations"."status" IN ('ACTIVE','SUSPENDED','CANCELLED'))
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"replaced_by_id" uuid,
	"user_agent" text,
	"ip" "inet",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"full_name" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_status_ck" CHECK ("users"."status" IN ('ACTIVE','INVITED','DISABLED'))
);
--> statement-breakpoint
CREATE TABLE "physical_rooms" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"room_type_id" uuid NOT NULL,
	"room_number" text NOT NULL,
	"floor" text,
	"housekeeping_status" text DEFAULT 'CLEAN' NOT NULL,
	"notes" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "physical_rooms_housekeeping_ck" CHECK ("physical_rooms"."housekeeping_status" IN ('CLEAN','DIRTY','INSPECTED','OUT_OF_ORDER'))
);
--> statement-breakpoint
CREATE TABLE "properties" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"timezone" text DEFAULT 'Asia/Bangkok' NOT NULL,
	"currency" char(3) DEFAULT 'THB' NOT NULL,
	"country" char(2) DEFAULT 'TH' NOT NULL,
	"address_line1" text,
	"address_line2" text,
	"city" text,
	"postal_code" text,
	"phone" text,
	"email" text,
	"check_in_time" time DEFAULT '14:00' NOT NULL,
	"check_out_time" time DEFAULT '12:00' NOT NULL,
	"tax_rate_bp" integer DEFAULT 700 NOT NULL,
	"service_charge_rate_bp" integer DEFAULT 1000 NOT NULL,
	"prices_include_tax" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "properties_status_ck" CHECK ("properties"."status" IN ('ACTIVE','INACTIVE')),
	CONSTRAINT "properties_tax_rate_ck" CHECK ("properties"."tax_rate_bp" BETWEEN 0 AND 10000),
	CONSTRAINT "properties_service_charge_ck" CHECK ("properties"."service_charge_rate_bp" BETWEEN 0 AND 10000)
);
--> statement-breakpoint
CREATE TABLE "rate_plans" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"room_type_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"parent_rate_plan_id" uuid,
	"derivation_type" text,
	"derivation_value" integer,
	"meal_plan" text DEFAULT 'ROOM_ONLY' NOT NULL,
	"cancellation_policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_refundable" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rate_plans_meal_plan_ck" CHECK ("rate_plans"."meal_plan" IN ('ROOM_ONLY','BREAKFAST','HALF_BOARD','FULL_BOARD','ALL_INCLUSIVE')),
	CONSTRAINT "rate_plans_derivation_type_ck" CHECK ("rate_plans"."derivation_type" IS NULL OR "rate_plans"."derivation_type" IN ('PERCENTAGE','AMOUNT')),
	CONSTRAINT "rate_plans_derivation_ck" CHECK (("rate_plans"."parent_rate_plan_id" IS NULL AND "rate_plans"."derivation_type" IS NULL AND "rate_plans"."derivation_value" IS NULL)
          OR ("rate_plans"."parent_rate_plan_id" IS NOT NULL AND "rate_plans"."derivation_type" IS NOT NULL AND "rate_plans"."derivation_value" IS NOT NULL)),
	CONSTRAINT "rate_plans_no_self_parent_ck" CHECK ("rate_plans"."parent_rate_plan_id" <> "rate_plans"."id")
);
--> statement-breakpoint
CREATE TABLE "room_types" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"standard_occupancy" smallint DEFAULT 2 NOT NULL,
	"max_occupancy" smallint DEFAULT 2 NOT NULL,
	"max_adults" smallint DEFAULT 2 NOT NULL,
	"max_children" smallint DEFAULT 0 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_types_occupancy_ck" CHECK ("room_types"."standard_occupancy" <= "room_types"."max_occupancy"),
	CONSTRAINT "room_types_standard_occupancy_ck" CHECK ("room_types"."standard_occupancy" >= 1),
	CONSTRAINT "room_types_max_occupancy_ck" CHECK ("room_types"."max_occupancy" >= 1),
	CONSTRAINT "room_types_max_children_ck" CHECK ("room_types"."max_children" >= 0)
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"property_id" uuid,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_role_ck" CHECK ("memberships"."role" IN ('OWNER','ADMIN','MANAGER','FRONT_DESK','READ_ONLY'))
);
--> statement-breakpoint
CREATE TABLE "inventory_days" (
	"organization_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"room_type_id" uuid NOT NULL,
	"date" date NOT NULL,
	"allotment" integer DEFAULT 0 NOT NULL,
	"booked" integer DEFAULT 0 NOT NULL,
	"stop_sell" boolean DEFAULT false NOT NULL,
	"min_stay" smallint DEFAULT 1 NOT NULL,
	"max_stay" smallint,
	"closed_to_arrival" boolean DEFAULT false NOT NULL,
	"closed_to_departure" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_days_pk" PRIMARY KEY("room_type_id","date"),
	CONSTRAINT "inventory_booked_range_ck" CHECK ("inventory_days"."booked" >= 0 AND "inventory_days"."booked" <= "inventory_days"."allotment"),
	CONSTRAINT "inventory_allotment_nonneg_ck" CHECK ("inventory_days"."allotment" >= 0),
	CONSTRAINT "inventory_min_stay_ck" CHECK ("inventory_days"."min_stay" >= 1),
	CONSTRAINT "inventory_max_stay_ck" CHECK ("inventory_days"."max_stay" IS NULL OR "inventory_days"."max_stay" >= "inventory_days"."min_stay")
);
--> statement-breakpoint
CREATE TABLE "rate_days" (
	"organization_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"rate_plan_id" uuid NOT NULL,
	"date" date NOT NULL,
	"occupancy" smallint NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rate_days_pk" PRIMARY KEY("rate_plan_id","date","occupancy"),
	CONSTRAINT "rate_days_occupancy_ck" CHECK ("rate_days"."occupancy" >= 1),
	CONSTRAINT "rate_days_amount_ck" CHECK ("rate_days"."amount_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "guests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text,
	"email" text,
	"phone" text,
	"nationality" char(2),
	"document_type" text,
	"document_number_encrypted" "bytea",
	"date_of_birth" date,
	"preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guests_document_type_ck" CHECK ("guests"."document_type" IS NULL OR "guests"."document_type" IN ('PASSPORT','NATIONAL_ID','DRIVING_LICENSE'))
);
--> statement-breakpoint
CREATE TABLE "channel_rate_plan_mappings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"rate_plan_id" uuid NOT NULL,
	"external_rate_id" text NOT NULL,
	"external_rate_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_room_type_mappings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"room_type_id" uuid NOT NULL,
	"external_room_id" text NOT NULL,
	"external_room_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'INACTIVE' NOT NULL,
	"credentials_encrypted" "bytea",
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sync_horizon_days" smallint DEFAULT 365 NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channels_type_ck" CHECK ("channels"."type" IN ('MOCK_OTA','AGODA','BOOKING_COM','EXPEDIA','TRIP_COM','AIRBNB','DIRECT')),
	CONSTRAINT "channels_status_ck" CHECK ("channels"."status" IN ('ACTIVE','INACTIVE','ERROR')),
	CONSTRAINT "channels_horizon_ck" CHECK ("channels"."sync_horizon_days" BETWEEN 1 AND 730)
);
--> statement-breakpoint
CREATE TABLE "sync_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"room_type_id" uuid,
	"date_from" date,
	"date_to" date,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"last_error" text,
	"scheduled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "sync_jobs_kind_ck" CHECK ("sync_jobs"."kind" IN ('ARI_PUSH','RESERVATION_PULL','FULL_SYNC')),
	CONSTRAINT "sync_jobs_status_ck" CHECK ("sync_jobs"."status" IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','DEAD_LETTER')),
	CONSTRAINT "sync_jobs_date_order_ck" CHECK ("sync_jobs"."date_to" IS NULL OR "sync_jobs"."date_from" IS NULL OR "sync_jobs"."date_to" >= "sync_jobs"."date_from")
);
--> statement-breakpoint
CREATE TABLE "channel_reservations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"external_reservation_id" text NOT NULL,
	"external_status" text,
	"raw_payload" jsonb NOT NULL,
	"status" text DEFAULT 'RECEIVED' NOT NULL,
	"reservation_id" uuid,
	"error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "channel_reservations_status_ck" CHECK ("channel_reservations"."status" IN ('RECEIVED','PROCESSED','FAILED','IGNORED'))
);
--> statement-breakpoint
CREATE TABLE "reservation_stay_nights" (
	"stay_id" uuid NOT NULL,
	"date" date NOT NULL,
	"organization_id" uuid NOT NULL,
	"reservation_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"room_type_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	CONSTRAINT "reservation_stay_nights_pk" PRIMARY KEY("stay_id","date"),
	CONSTRAINT "rsn_amount_ck" CHECK ("reservation_stay_nights"."amount_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "reservation_stays" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"reservation_id" uuid NOT NULL,
	"room_type_id" uuid NOT NULL,
	"rate_plan_id" uuid NOT NULL,
	"check_in" date NOT NULL,
	"check_out" date NOT NULL,
	"adults" smallint DEFAULT 1 NOT NULL,
	"children" smallint DEFAULT 0 NOT NULL,
	"assigned_room_id" uuid,
	"guest_name" text,
	"subtotal_minor" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stays_date_order_ck" CHECK ("reservation_stays"."check_out" > "reservation_stays"."check_in"),
	CONSTRAINT "stays_adults_ck" CHECK ("reservation_stays"."adults" >= 1),
	CONSTRAINT "stays_children_ck" CHECK ("reservation_stays"."children" >= 0)
);
--> statement-breakpoint
CREATE TABLE "reservations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"code" text NOT NULL,
	"status" text NOT NULL,
	"channel_id" uuid,
	"source" text DEFAULT 'DIRECT' NOT NULL,
	"guest_id" uuid,
	"booker_name" text NOT NULL,
	"booker_email" text,
	"booker_phone" text,
	"currency" char(3) NOT NULL,
	"subtotal_minor" bigint DEFAULT 0 NOT NULL,
	"tax_minor" bigint DEFAULT 0 NOT NULL,
	"service_charge_minor" bigint DEFAULT 0 NOT NULL,
	"total_minor" bigint DEFAULT 0 NOT NULL,
	"hold_expires_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancellation_reason" text,
	"special_requests" text,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reservations_status_ck" CHECK ("reservations"."status" IN ('PENDING','CONFIRMED','CHECKED_IN','CHECKED_OUT','CANCELLED','NO_SHOW','EXPIRED')),
	CONSTRAINT "reservations_source_ck" CHECK ("reservations"."source" IN ('DIRECT','OTA','WALK_IN','PHONE','EMAIL')),
	CONSTRAINT "reservations_hold_ck" CHECK ("reservations"."status" <> 'PENDING' OR "reservations"."hold_expires_at" IS NOT NULL),
	CONSTRAINT "reservations_subtotal_ck" CHECK ("reservations"."subtotal_minor" >= 0),
	CONSTRAINT "reservations_total_ck" CHECK ("reservations"."total_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"property_id" uuid,
	"actor_type" text NOT NULL,
	"actor_user_id" uuid,
	"actor_label" text,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid,
	"before" jsonb,
	"after" jsonb,
	"reason" text,
	"ip" "inet",
	"user_agent" text,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_logs_actor_type_ck" CHECK ("audit_logs"."actor_type" IN ('USER','SYSTEM','CHANNEL'))
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"key" text PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"property_id" uuid,
	"aggregate_type" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"last_error" text
);
--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_replaced_by_id_refresh_tokens_id_fk" FOREIGN KEY ("replaced_by_id") REFERENCES "public"."refresh_tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "physical_rooms" ADD CONSTRAINT "physical_rooms_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "physical_rooms" ADD CONSTRAINT "physical_rooms_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "physical_rooms" ADD CONSTRAINT "physical_rooms_room_type_id_room_types_id_fk" FOREIGN KEY ("room_type_id") REFERENCES "public"."room_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_plans" ADD CONSTRAINT "rate_plans_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_plans" ADD CONSTRAINT "rate_plans_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_plans" ADD CONSTRAINT "rate_plans_room_type_id_room_types_id_fk" FOREIGN KEY ("room_type_id") REFERENCES "public"."room_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_plans" ADD CONSTRAINT "rate_plans_parent_rate_plan_id_rate_plans_id_fk" FOREIGN KEY ("parent_rate_plan_id") REFERENCES "public"."rate_plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_types" ADD CONSTRAINT "room_types_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_types" ADD CONSTRAINT "room_types_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_days" ADD CONSTRAINT "inventory_days_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_days" ADD CONSTRAINT "inventory_days_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_days" ADD CONSTRAINT "inventory_days_room_type_id_room_types_id_fk" FOREIGN KEY ("room_type_id") REFERENCES "public"."room_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_days" ADD CONSTRAINT "rate_days_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_days" ADD CONSTRAINT "rate_days_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_days" ADD CONSTRAINT "rate_days_rate_plan_id_rate_plans_id_fk" FOREIGN KEY ("rate_plan_id") REFERENCES "public"."rate_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guests" ADD CONSTRAINT "guests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_rate_plan_mappings" ADD CONSTRAINT "channel_rate_plan_mappings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_rate_plan_mappings" ADD CONSTRAINT "channel_rate_plan_mappings_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_rate_plan_mappings" ADD CONSTRAINT "channel_rate_plan_mappings_rate_plan_id_rate_plans_id_fk" FOREIGN KEY ("rate_plan_id") REFERENCES "public"."rate_plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_room_type_mappings" ADD CONSTRAINT "channel_room_type_mappings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_room_type_mappings" ADD CONSTRAINT "channel_room_type_mappings_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_room_type_mappings" ADD CONSTRAINT "channel_room_type_mappings_room_type_id_room_types_id_fk" FOREIGN KEY ("room_type_id") REFERENCES "public"."room_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_room_type_id_room_types_id_fk" FOREIGN KEY ("room_type_id") REFERENCES "public"."room_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_reservations" ADD CONSTRAINT "channel_reservations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_reservations" ADD CONSTRAINT "channel_reservations_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_reservations" ADD CONSTRAINT "channel_reservations_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_stay_nights" ADD CONSTRAINT "reservation_stay_nights_stay_id_reservation_stays_id_fk" FOREIGN KEY ("stay_id") REFERENCES "public"."reservation_stays"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_stay_nights" ADD CONSTRAINT "reservation_stay_nights_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_stay_nights" ADD CONSTRAINT "reservation_stay_nights_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_stay_nights" ADD CONSTRAINT "reservation_stay_nights_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_stay_nights" ADD CONSTRAINT "reservation_stay_nights_room_type_id_room_types_id_fk" FOREIGN KEY ("room_type_id") REFERENCES "public"."room_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_stays" ADD CONSTRAINT "reservation_stays_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_stays" ADD CONSTRAINT "reservation_stays_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_stays" ADD CONSTRAINT "reservation_stays_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_stays" ADD CONSTRAINT "reservation_stays_room_type_id_room_types_id_fk" FOREIGN KEY ("room_type_id") REFERENCES "public"."room_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_stays" ADD CONSTRAINT "reservation_stays_rate_plan_id_rate_plans_id_fk" FOREIGN KEY ("rate_plan_id") REFERENCES "public"."rate_plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_stays" ADD CONSTRAINT "reservation_stays_assigned_room_id_physical_rooms_id_fk" FOREIGN KEY ("assigned_room_id") REFERENCES "public"."physical_rooms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."guests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_slug_uq" ON "organizations" USING btree (lower("slug"));--> statement-breakpoint
CREATE UNIQUE INDEX "refresh_tokens_hash_uq" ON "refresh_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "refresh_tokens_user_active_idx" ON "refresh_tokens" USING btree ("user_id") WHERE "refresh_tokens"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "users_org_email_uq" ON "users" USING btree ("organization_id",lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "physical_rooms_property_number_uq" ON "physical_rooms" USING btree ("property_id",lower("room_number"));--> statement-breakpoint
CREATE UNIQUE INDEX "properties_org_code_uq" ON "properties" USING btree ("organization_id",lower("code"));--> statement-breakpoint
CREATE UNIQUE INDEX "rate_plans_property_code_uq" ON "rate_plans" USING btree ("property_id",lower("code"));--> statement-breakpoint
CREATE UNIQUE INDEX "room_types_property_code_uq" ON "room_types" USING btree ("property_id",lower("code"));--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_user_property_uq" ON "memberships" USING btree ("user_id","property_id") WHERE "memberships"."property_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_user_org_wide_uq" ON "memberships" USING btree ("user_id") WHERE "memberships"."property_id" IS NULL;--> statement-breakpoint
CREATE INDEX "inventory_days_property_updated_idx" ON "inventory_days" USING btree ("property_id","updated_at");--> statement-breakpoint
CREATE INDEX "inventory_days_property_date_idx" ON "inventory_days" USING btree ("property_id","date");--> statement-breakpoint
CREATE INDEX "rate_days_property_updated_idx" ON "rate_days" USING btree ("property_id","updated_at");--> statement-breakpoint
CREATE INDEX "rate_days_property_date_idx" ON "rate_days" USING btree ("property_id","date");--> statement-breakpoint
CREATE INDEX "guests_org_email_idx" ON "guests" USING btree ("organization_id",lower("email"));--> statement-breakpoint
CREATE INDEX "guests_org_phone_idx" ON "guests" USING btree ("organization_id","phone");--> statement-breakpoint
CREATE INDEX "guests_org_name_idx" ON "guests" USING btree ("organization_id",lower("last_name"),lower("first_name"));--> statement-breakpoint
CREATE UNIQUE INDEX "crpm_channel_rateplan_uq" ON "channel_rate_plan_mappings" USING btree ("channel_id","rate_plan_id");--> statement-breakpoint
CREATE UNIQUE INDEX "crpm_channel_external_uq" ON "channel_rate_plan_mappings" USING btree ("channel_id","external_rate_id");--> statement-breakpoint
CREATE UNIQUE INDEX "crtm_channel_roomtype_uq" ON "channel_room_type_mappings" USING btree ("channel_id","room_type_id");--> statement-breakpoint
CREATE UNIQUE INDEX "crtm_channel_external_uq" ON "channel_room_type_mappings" USING btree ("channel_id","external_room_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channels_property_type_active_uq" ON "channels" USING btree ("property_id","type") WHERE "channels"."status" <> 'INACTIVE';--> statement-breakpoint
CREATE INDEX "sync_jobs_channel_status_idx" ON "sync_jobs" USING btree ("channel_id","status","scheduled_at");--> statement-breakpoint
CREATE INDEX "sync_jobs_completed_idx" ON "sync_jobs" USING btree ("channel_id","completed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "channel_reservations_dedupe_uq" ON "channel_reservations" USING btree ("channel_id","external_reservation_id");--> statement-breakpoint
CREATE INDEX "channel_reservations_unprocessed_idx" ON "channel_reservations" USING btree ("channel_id","received_at") WHERE "channel_reservations"."status" IN ('RECEIVED','FAILED');--> statement-breakpoint
CREATE INDEX "rsn_property_roomtype_date_idx" ON "reservation_stay_nights" USING btree ("property_id","room_type_id","date");--> statement-breakpoint
CREATE INDEX "rsn_reservation_idx" ON "reservation_stay_nights" USING btree ("reservation_id");--> statement-breakpoint
CREATE INDEX "reservation_stays_reservation_idx" ON "reservation_stays" USING btree ("reservation_id");--> statement-breakpoint
CREATE INDEX "reservation_stays_arrivals_idx" ON "reservation_stays" USING btree ("property_id","check_in");--> statement-breakpoint
CREATE INDEX "reservation_stays_departures_idx" ON "reservation_stays" USING btree ("property_id","check_out");--> statement-breakpoint
CREATE UNIQUE INDEX "reservations_property_code_uq" ON "reservations" USING btree ("property_id",upper("code"));--> statement-breakpoint
CREATE INDEX "reservations_property_status_idx" ON "reservations" USING btree ("property_id","status");--> statement-breakpoint
CREATE INDEX "reservations_property_created_idx" ON "reservations" USING btree ("property_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "reservations_guest_idx" ON "reservations" USING btree ("guest_id") WHERE "reservations"."guest_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "reservations_pending_expiry_idx" ON "reservations" USING btree ("hold_expires_at") WHERE "reservations"."status" = 'PENDING';--> statement-breakpoint
CREATE INDEX "audit_logs_entity_idx" ON "audit_logs" USING btree ("entity_type","entity_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_logs_org_time_idx" ON "audit_logs" USING btree ("organization_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_logs_actor_idx" ON "audit_logs" USING btree ("actor_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idempotency_keys_expiry_idx" ON "idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "outbox_unpublished_idx" ON "outbox_events" USING btree ("occurred_at") WHERE "outbox_events"."published_at" IS NULL;