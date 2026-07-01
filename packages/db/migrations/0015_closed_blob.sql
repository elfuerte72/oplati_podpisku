CREATE TABLE "referral_monthly_stats" (
	"user_id" uuid NOT NULL,
	"month" date NOT NULL,
	"network_turnover_usd_cents" integer DEFAULT 0 NOT NULL,
	"new_active_referrals" integer DEFAULT 0 NOT NULL,
	"active_l2" integer DEFAULT 0 NOT NULL,
	"plan_met" boolean DEFAULT false NOT NULL,
	"consecutive_met_months" integer DEFAULT 0 NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "referral_monthly_stats_user_id_month_pk" PRIMARY KEY("user_id","month"),
	CONSTRAINT "referral_monthly_stats_turnover_nonneg" CHECK ("referral_monthly_stats"."network_turnover_usd_cents" >= 0)
);
--> statement-breakpoint
ALTER TABLE "referral_monthly_stats" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "referral_monthly_stats" ADD CONSTRAINT "referral_monthly_stats_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;