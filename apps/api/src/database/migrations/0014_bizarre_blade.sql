-- The language a person reads the dashboard in, saved on the account so it
-- follows them between machines. Additive and nullable.
--
-- ROLLBACK (Definition of Done): reversible.
--   ALTER TABLE users DROP CONSTRAINT users_preferred_locale_ck;
--   ALTER TABLE users DROP COLUMN preferred_locale;
-- Costs only the saved choices; every browser keeps its own cookie.

ALTER TABLE "users" ADD COLUMN "preferred_locale" text;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_preferred_locale_ck" CHECK ("users"."preferred_locale" IS NULL OR "users"."preferred_locale" IN ('en','th'));