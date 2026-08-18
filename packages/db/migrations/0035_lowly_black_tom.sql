ALTER TABLE "staff" ADD COLUMN "totp_secret" text;--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN "totp_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN "last_login_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "staff" ADD CONSTRAINT "staff_telegram_id_unique" UNIQUE("telegram_id");