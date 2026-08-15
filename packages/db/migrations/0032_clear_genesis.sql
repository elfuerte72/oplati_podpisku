ALTER TABLE "payments" ADD COLUMN "last_provider_status" integer;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "last_provider_status_at" timestamp with time zone;