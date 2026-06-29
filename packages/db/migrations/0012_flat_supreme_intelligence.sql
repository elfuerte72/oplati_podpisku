CREATE TYPE "public"."referral_accrual_kind" AS ENUM('commission', 'circle_bonus', 'sprint_new_refs', 'sprint_turnover_boost', 'serial_bonus');--> statement-breakpoint
CREATE TYPE "public"."referral_accrual_status" AS ENUM('accrued', 'reversed');--> statement-breakpoint
CREATE TYPE "public"."referral_payout_status" AS ENUM('requested', 'processing', 'paid', 'rejected');--> statement-breakpoint
CREATE TABLE "referral_accruals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"beneficiary_user_id" uuid NOT NULL,
	"source_user_id" uuid,
	"order_id" uuid,
	"payment_id" uuid,
	"level" integer NOT NULL,
	"kind" "referral_accrual_kind" NOT NULL,
	"rate_bps" integer NOT NULL,
	"amount_usd_cents" integer NOT NULL,
	"status" "referral_accrual_status" DEFAULT 'accrued' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "referral_accruals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "referral_partners" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"current_circle" integer DEFAULT 0 NOT NULL,
	"locked_rate_l1_bps" integer DEFAULT 400 NOT NULL,
	"boost_until" date,
	"boost_rate_bps" integer,
	"team_multiplier" boolean DEFAULT false NOT NULL,
	"suspended" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "referral_partners" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "referral_payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"amount_usd_cents" integer NOT NULL,
	"status" "referral_payout_status" DEFAULT 'requested' NOT NULL,
	"destination" jsonb,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "referral_payouts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "referral_accruals" ADD CONSTRAINT "referral_accruals_beneficiary_user_id_users_id_fk" FOREIGN KEY ("beneficiary_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_accruals" ADD CONSTRAINT "referral_accruals_source_user_id_users_id_fk" FOREIGN KEY ("source_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_accruals" ADD CONSTRAINT "referral_accruals_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_accruals" ADD CONSTRAINT "referral_accruals_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_partners" ADD CONSTRAINT "referral_partners_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_payouts" ADD CONSTRAINT "referral_payouts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "referral_accruals_beneficiary_idx" ON "referral_accruals" USING btree ("beneficiary_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "referral_accruals_payment_beneficiary_level_idx" ON "referral_accruals" USING btree ("payment_id","beneficiary_user_id","level");--> statement-breakpoint
CREATE INDEX "referral_payouts_user_idx" ON "referral_payouts" USING btree ("user_id");