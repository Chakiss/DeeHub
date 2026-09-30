ALTER TABLE "rate_plans" ADD COLUMN "cancellation_notice_hours" smallint DEFAULT 24 NOT NULL;--> statement-breakpoint
ALTER TABLE "rate_plans" ADD COLUMN "cancellation_refund_percent" smallint DEFAULT 50 NOT NULL;--> statement-breakpoint
ALTER TABLE "reservation_stays" ADD COLUMN "cancellation_notice_hours" smallint;--> statement-breakpoint
ALTER TABLE "reservation_stays" ADD COLUMN "cancellation_refund_percent" smallint;--> statement-breakpoint
ALTER TABLE "rate_plans" ADD CONSTRAINT "rate_plans_cancel_notice_ck" CHECK ("rate_plans"."cancellation_notice_hours" BETWEEN 0 AND 720);--> statement-breakpoint
ALTER TABLE "rate_plans" ADD CONSTRAINT "rate_plans_cancel_refund_ck" CHECK ("rate_plans"."cancellation_refund_percent" BETWEEN 0 AND 100);--> statement-breakpoint
ALTER TABLE "reservation_stays" ADD CONSTRAINT "stays_cancel_notice_ck" CHECK ("reservation_stays"."cancellation_notice_hours" IS NULL OR "reservation_stays"."cancellation_notice_hours" BETWEEN 0 AND 720);--> statement-breakpoint
ALTER TABLE "reservation_stays" ADD CONSTRAINT "stays_cancel_refund_ck" CHECK ("reservation_stays"."cancellation_refund_percent" IS NULL OR "reservation_stays"."cancellation_refund_percent" BETWEEN 0 AND 100);