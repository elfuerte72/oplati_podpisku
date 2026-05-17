CREATE TYPE "public"."card_status" AS ENUM('active', 'idle', 'recycled');--> statement-breakpoint
ALTER TYPE "public"."payment_provider" ADD VALUE 'loveandpay';--> statement-breakpoint
ALTER TYPE "public"."payment_provider" ADD VALUE 'paypace';--> statement-breakpoint
CREATE TABLE "cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text DEFAULT 'paypace' NOT NULL,
	"provider_card_id" text NOT NULL,
	"pan_masked" text NOT NULL,
	"status" "card_status" DEFAULT 'active' NOT NULL,
	"balance_usd_cents" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone,
	"recycled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cards_provider_card_id_unique" UNIQUE("provider_card_id")
);
--> statement-breakpoint
ALTER TABLE "cards" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "usdt_rub_rate_kopecks" integer;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "rate_fixed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "commission_percent" integer;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "card_id" uuid;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "provider_invoice_number" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "recovered_via_polling" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "webhook_received_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cards_user_id_idx" ON "cards" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "cards_idle_idx" ON "cards" USING btree ("status") WHERE "cards"."status" = 'idle';--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE set null ON UPDATE no action;