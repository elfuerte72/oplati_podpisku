CREATE TABLE "vpn_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"telegram_id" text NOT NULL,
	"remnawave_uuid" uuid NOT NULL,
	"short_uuid" text NOT NULL,
	"subscription_url" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"expire_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vpn_subscriptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "vpn_subscriptions" ADD CONSTRAINT "vpn_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "vpn_subscriptions_user_id_idx" ON "vpn_subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vpn_subscriptions_telegram_id_idx" ON "vpn_subscriptions" USING btree ("telegram_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vpn_subscriptions_remnawave_uuid_idx" ON "vpn_subscriptions" USING btree ("remnawave_uuid");