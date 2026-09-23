-- Accounting phase 1 — the hotel's own books (docs/accounting-plan.md, ADR-0008).
--
-- Six new tables. Nothing existing is altered and nothing references them, so
-- this migration is additive and safe to deploy ahead of the code that reads it.
--
-- ROLLBACK (Definition of Done): reversible. Drop in reverse dependency order —
--   DROP TABLE revenue_entries, expense_recurrences, expenses, vendors,
--              expense_categories, accounting_settings;
-- No other table loses a column or a constraint, so a rollback costs only the
-- accounting rows entered since deploy. If those matter, restore them from PITR
-- rather than replaying them by hand: an expense carries a withholding figure
-- that has already been remitted, and re-typing it is how the two stop agreeing.

CREATE TABLE "accounting_settings" (
	"property_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"taxpayer_type" text,
	"tax_id" text,
	"branch_code" text DEFAULT '00000' NOT NULL,
	"legal_name_th" text,
	"legal_name_en" text,
	"address_th" text,
	"vat_registered" boolean DEFAULT false NOT NULL,
	"vat_registered_from" date,
	"withholding_enabled" boolean DEFAULT true NOT NULL,
	"local_levy_enabled" boolean DEFAULT false NOT NULL,
	"local_levy_rate_bp" integer DEFAULT 0 NOT NULL,
	"fiscal_year_start_month" smallint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounting_settings_taxpayer_type_ck" CHECK ("accounting_settings"."taxpayer_type" IS NULL OR "accounting_settings"."taxpayer_type" IN ('INDIVIDUAL','JURISTIC')),
	CONSTRAINT "accounting_settings_branch_code_ck" CHECK ("accounting_settings"."branch_code" ~ '^[0-9]{5}$'),
	CONSTRAINT "accounting_settings_tax_id_ck" CHECK ("accounting_settings"."tax_id" IS NULL OR "accounting_settings"."tax_id" ~ '^[0-9]{13}$'),
	CONSTRAINT "accounting_settings_levy_rate_ck" CHECK ("accounting_settings"."local_levy_rate_bp" BETWEEN 0 AND 10000),
	CONSTRAINT "accounting_settings_fiscal_month_ck" CHECK ("accounting_settings"."fiscal_year_start_month" BETWEEN 1 AND 12),
	CONSTRAINT "accounting_settings_vat_from_ck" CHECK ("accounting_settings"."vat_registered" = false OR "accounting_settings"."vat_registered_from" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "expense_categories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name_th" text NOT NULL,
	"name_en" text NOT NULL,
	"group" text NOT NULL,
	"default_wht_rate_bp" integer DEFAULT 0 NOT NULL,
	"default_wht_income_type" text,
	"is_deductible" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expense_categories_group_ck" CHECK ("expense_categories"."group" IN ('COGS','PAYROLL','UTILITIES','OPERATIONS','MARKETING','ADMIN','FINANCE','TAX','OTHER')),
	CONSTRAINT "expense_categories_wht_rate_ck" CHECK ("expense_categories"."default_wht_rate_bp" BETWEEN 0 AND 10000)
);
--> statement-breakpoint
CREATE TABLE "expense_recurrences" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"vendor_id" uuid,
	"label" text NOT NULL,
	"day_of_month" smallint DEFAULT 1 NOT NULL,
	"expected_amount_minor" bigint,
	"currency" char(3) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expense_recurrences_day_ck" CHECK ("expense_recurrences"."day_of_month" BETWEEN 1 AND 28),
	CONSTRAINT "expense_recurrences_amount_ck" CHECK ("expense_recurrences"."expected_amount_minor" IS NULL OR "expense_recurrences"."expected_amount_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"vendor_id" uuid,
	"kind" text DEFAULT 'EXPENSE' NOT NULL,
	"description" text NOT NULL,
	"currency" char(3) NOT NULL,
	"net_amount_minor" bigint NOT NULL,
	"vat_minor" bigint DEFAULT 0 NOT NULL,
	"self_assessed_vat_minor" bigint DEFAULT 0 NOT NULL,
	"vat_claimable" boolean DEFAULT true NOT NULL,
	"gross_amount_minor" bigint NOT NULL,
	"wht_rate_bp" integer DEFAULT 0 NOT NULL,
	"wht_minor" bigint DEFAULT 0 NOT NULL,
	"paid_amount_minor" bigint NOT NULL,
	"expense_date" date NOT NULL,
	"paid_date" date,
	"payment_method" text,
	"vat_claimed_period" char(7),
	"supplier_doc_number" text,
	"supplier_doc_date" date,
	"supplier_doc_type" text,
	"attachment_ref" text,
	"note" text,
	"recorded_by_user_id" uuid,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_reason" text,
	"voided_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expenses_kind_ck" CHECK ("expenses"."kind" IN ('EXPENSE','VENDOR_CREDIT_NOTE')),
	CONSTRAINT "expenses_gross_positive_ck" CHECK ("expenses"."gross_amount_minor" > 0),
	CONSTRAINT "expenses_net_nonnegative_ck" CHECK ("expenses"."net_amount_minor" >= 0),
	CONSTRAINT "expenses_vat_nonnegative_ck" CHECK ("expenses"."vat_minor" >= 0),
	CONSTRAINT "expenses_self_assessed_vat_ck" CHECK ("expenses"."self_assessed_vat_minor" >= 0),
	CONSTRAINT "expenses_wht_nonnegative_ck" CHECK ("expenses"."wht_minor" >= 0),
	CONSTRAINT "expenses_wht_rate_ck" CHECK ("expenses"."wht_rate_bp" BETWEEN 0 AND 10000),
	CONSTRAINT "expenses_gross_ck" CHECK ("expenses"."gross_amount_minor" = "expenses"."net_amount_minor" + "expenses"."vat_minor"),
	CONSTRAINT "expenses_paid_ck" CHECK ("expenses"."paid_amount_minor" = "expenses"."gross_amount_minor" - "expenses"."wht_minor"),
	CONSTRAINT "expenses_wht_bound_ck" CHECK ("expenses"."wht_minor" <= "expenses"."gross_amount_minor"),
	CONSTRAINT "expenses_payment_method_ck" CHECK ("expenses"."payment_method" IS NULL OR "expenses"."payment_method" IN ('CASH','BANK_TRANSFER','PROMPTPAY','CARD','CHEQUE','OTHER')),
	CONSTRAINT "expenses_supplier_doc_type_ck" CHECK ("expenses"."supplier_doc_type" IS NULL OR "expenses"."supplier_doc_type" IN ('TAX_INVOICE','RECEIPT','INVOICE','NONE')),
	CONSTRAINT "expenses_paid_date_ck" CHECK (("expenses"."paid_date" IS NULL) = ("expenses"."payment_method" IS NULL)),
	CONSTRAINT "expenses_vat_claimed_period_ck" CHECK ("expenses"."vat_claimed_period" ~ '^[0-9]{4}-[0-9]{2}$'),
	CONSTRAINT "expenses_void_ck" CHECK (("expenses"."voided_at" IS NULL) = ("expenses"."voided_reason" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "revenue_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"kind" text DEFAULT 'INCOME' NOT NULL,
	"category" text NOT NULL,
	"description" text NOT NULL,
	"payer_name" text,
	"payer_tax_id" text,
	"currency" char(3) NOT NULL,
	"net_amount_minor" bigint NOT NULL,
	"vat_minor" bigint DEFAULT 0 NOT NULL,
	"gross_amount_minor" bigint NOT NULL,
	"wht_withheld_minor" bigint DEFAULT 0 NOT NULL,
	"received_amount_minor" bigint NOT NULL,
	"income_date" date NOT NULL,
	"received_date" date,
	"payment_method" text,
	"note" text,
	"recorded_by_user_id" uuid,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_reason" text,
	"voided_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "revenue_entries_kind_ck" CHECK ("revenue_entries"."kind" IN ('INCOME','CREDIT_NOTE')),
	CONSTRAINT "revenue_entries_gross_positive_ck" CHECK ("revenue_entries"."gross_amount_minor" > 0),
	CONSTRAINT "revenue_entries_net_nonnegative_ck" CHECK ("revenue_entries"."net_amount_minor" >= 0),
	CONSTRAINT "revenue_entries_vat_nonnegative_ck" CHECK ("revenue_entries"."vat_minor" >= 0),
	CONSTRAINT "revenue_entries_wht_nonnegative_ck" CHECK ("revenue_entries"."wht_withheld_minor" >= 0),
	CONSTRAINT "revenue_entries_gross_ck" CHECK ("revenue_entries"."gross_amount_minor" = "revenue_entries"."net_amount_minor" + "revenue_entries"."vat_minor"),
	CONSTRAINT "revenue_entries_received_ck" CHECK ("revenue_entries"."received_amount_minor" = "revenue_entries"."gross_amount_minor" - "revenue_entries"."wht_withheld_minor"),
	CONSTRAINT "revenue_entries_wht_bound_ck" CHECK ("revenue_entries"."wht_withheld_minor" <= "revenue_entries"."gross_amount_minor"),
	CONSTRAINT "revenue_entries_payment_method_ck" CHECK ("revenue_entries"."payment_method" IS NULL OR "revenue_entries"."payment_method" IN ('CASH','BANK_TRANSFER','PROMPTPAY','CARD','CHEQUE','OTHER')),
	CONSTRAINT "revenue_entries_received_date_ck" CHECK (("revenue_entries"."received_date" IS NULL) = ("revenue_entries"."payment_method" IS NULL)),
	CONSTRAINT "revenue_entries_payer_tax_id_ck" CHECK ("revenue_entries"."payer_tax_id" IS NULL OR "revenue_entries"."payer_tax_id" ~ '^[0-9]{13}$'),
	CONSTRAINT "revenue_entries_void_ck" CHECK (("revenue_entries"."voided_at" IS NULL) = ("revenue_entries"."voided_reason" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "vendors" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"name" text NOT NULL,
	"tax_id" text,
	"branch_code" text,
	"taxpayer_type" text,
	"country" char(2) DEFAULT 'TH' NOT NULL,
	"is_foreign" boolean DEFAULT false NOT NULL,
	"address" text,
	"phone" text,
	"email" text,
	"default_category_id" uuid,
	"default_wht_rate_bp" integer,
	"note" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendors_taxpayer_type_ck" CHECK ("vendors"."taxpayer_type" IS NULL OR "vendors"."taxpayer_type" IN ('INDIVIDUAL','JURISTIC')),
	CONSTRAINT "vendors_tax_id_ck" CHECK ("vendors"."tax_id" IS NULL OR "vendors"."tax_id" ~ '^[0-9]{13}$'),
	CONSTRAINT "vendors_branch_code_ck" CHECK ("vendors"."branch_code" IS NULL OR "vendors"."branch_code" ~ '^[0-9]{5}$'),
	CONSTRAINT "vendors_wht_rate_ck" CHECK ("vendors"."default_wht_rate_bp" IS NULL OR "vendors"."default_wht_rate_bp" BETWEEN 0 AND 10000),
	CONSTRAINT "vendors_foreign_tax_id_ck" CHECK ("vendors"."is_foreign" = false OR "vendors"."tax_id" IS NULL)
);
--> statement-breakpoint
ALTER TABLE "accounting_settings" ADD CONSTRAINT "accounting_settings_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_settings" ADD CONSTRAINT "accounting_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_recurrences" ADD CONSTRAINT "expense_recurrences_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_recurrences" ADD CONSTRAINT "expense_recurrences_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_recurrences" ADD CONSTRAINT "expense_recurrences_category_id_expense_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."expense_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_recurrences" ADD CONSTRAINT "expense_recurrences_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_category_id_expense_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."expense_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_voided_by_user_id_users_id_fk" FOREIGN KEY ("voided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_entries" ADD CONSTRAINT "revenue_entries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_entries" ADD CONSTRAINT "revenue_entries_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_entries" ADD CONSTRAINT "revenue_entries_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_entries" ADD CONSTRAINT "revenue_entries_voided_by_user_id_users_id_fk" FOREIGN KEY ("voided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_default_category_id_expense_categories_id_fk" FOREIGN KEY ("default_category_id") REFERENCES "public"."expense_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "expense_categories_property_code_uq" ON "expense_categories" USING btree ("property_id",lower("code"));--> statement-breakpoint
CREATE INDEX "expense_categories_property_idx" ON "expense_categories" USING btree ("property_id","sort_order");--> statement-breakpoint
CREATE INDEX "expense_recurrences_property_idx" ON "expense_recurrences" USING btree ("property_id","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "expenses_supplier_doc_uq" ON "expenses" USING btree ("property_id","vendor_id","supplier_doc_number") WHERE "expenses"."vendor_id" IS NOT NULL AND "expenses"."supplier_doc_number" IS NOT NULL AND "expenses"."voided_at" IS NULL;--> statement-breakpoint
CREATE INDEX "expenses_property_expense_date_idx" ON "expenses" USING btree ("property_id","expense_date");--> statement-breakpoint
CREATE INDEX "expenses_property_paid_date_idx" ON "expenses" USING btree ("property_id","paid_date");--> statement-breakpoint
CREATE INDEX "expenses_property_category_idx" ON "expenses" USING btree ("property_id","category_id","expense_date");--> statement-breakpoint
CREATE INDEX "expenses_vendor_idx" ON "expenses" USING btree ("vendor_id","expense_date");--> statement-breakpoint
CREATE INDEX "expenses_vat_claimed_idx" ON "expenses" USING btree ("property_id","vat_claimed_period");--> statement-breakpoint
CREATE INDEX "revenue_entries_property_income_date_idx" ON "revenue_entries" USING btree ("property_id","income_date");--> statement-breakpoint
CREATE INDEX "revenue_entries_property_received_date_idx" ON "revenue_entries" USING btree ("property_id","received_date");--> statement-breakpoint
CREATE UNIQUE INDEX "vendors_property_name_uq" ON "vendors" USING btree ("property_id",lower("name"));--> statement-breakpoint
CREATE INDEX "vendors_property_active_idx" ON "vendors" USING btree ("property_id","is_active");