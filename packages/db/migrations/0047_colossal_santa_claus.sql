CREATE TYPE "public"."promo_redemption_status" AS ENUM('reserved', 'spent', 'released');--> statement-breakpoint
CREATE TABLE "promo_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"discount_usd_cents" integer NOT NULL,
	"cap_to_margin" boolean DEFAULT true NOT NULL,
	"min_order_amount_kopecks" integer,
	"per_user_limit" integer DEFAULT 1 NOT NULL,
	"max_redemptions" integer,
	"starts_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promo_codes_discount_positive" CHECK ("promo_codes"."discount_usd_cents" > 0),
	CONSTRAINT "promo_codes_per_user_limit_positive" CHECK ("promo_codes"."per_user_limit" > 0),
	CONSTRAINT "promo_codes_max_redemptions_positive" CHECK ("promo_codes"."max_redemptions" IS NULL OR "promo_codes"."max_redemptions" > 0),
	CONSTRAINT "promo_codes_min_order_positive" CHECK ("promo_codes"."min_order_amount_kopecks" IS NULL OR "promo_codes"."min_order_amount_kopecks" > 0),
	CONSTRAINT "promo_codes_window_sane" CHECK ("promo_codes"."starts_at" IS NULL OR "promo_codes"."expires_at" IS NULL OR "promo_codes"."expires_at" > "promo_codes"."starts_at")
);
--> statement-breakpoint
ALTER TABLE "promo_codes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "promo_redemptions" (
	"order_id" uuid PRIMARY KEY NOT NULL,
	"promo_code_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"discount_usd_cents" integer NOT NULL,
	"discount_kopecks" integer NOT NULL,
	"rate_kopecks" integer NOT NULL,
	"status" "promo_redemption_status" DEFAULT 'reserved' NOT NULL,
	"released_by" uuid,
	"reserved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "promo_redemptions_discount_positive" CHECK ("promo_redemptions"."discount_kopecks" > 0),
	CONSTRAINT "promo_redemptions_usd_positive" CHECK ("promo_redemptions"."discount_usd_cents" > 0)
);
--> statement-breakpoint
ALTER TABLE "promo_redemptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "promo_redemptions" ADD CONSTRAINT "promo_redemptions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_redemptions" ADD CONSTRAINT "promo_redemptions_promo_code_id_promo_codes_id_fk" FOREIGN KEY ("promo_code_id") REFERENCES "public"."promo_codes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_redemptions" ADD CONSTRAINT "promo_redemptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_redemptions" ADD CONSTRAINT "promo_redemptions_released_by_staff_id_fk" FOREIGN KEY ("released_by") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "promo_codes_code_unique" ON "promo_codes" USING btree ("code");--> statement-breakpoint
CREATE INDEX "promo_redemptions_promo_user_idx" ON "promo_redemptions" USING btree ("promo_code_id","user_id");--> statement-breakpoint
CREATE INDEX "promo_redemptions_user_idx" ON "promo_redemptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "promo_redemptions_released_by_idx" ON "promo_redemptions" USING btree ("released_by");