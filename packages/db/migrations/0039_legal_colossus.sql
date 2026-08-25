CREATE TABLE "vcc_balance_snapshots" (
	"provider" text PRIMARY KEY NOT NULL,
	"balance_usd_cents" integer NOT NULL,
	"pending_usd_cents" integer NOT NULL,
	"read_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vcc_balance_snapshots" ENABLE ROW LEVEL SECURITY;