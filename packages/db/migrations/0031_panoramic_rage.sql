ALTER TABLE "users" ADD COLUMN "last_seen_ip" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_seen_ip_at" timestamp with time zone;