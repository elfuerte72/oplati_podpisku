-- Воронка обратной связи и удержания (спека .scratch/retention-funnel/, тикет 01):
-- opt-out у пользователя, журнал отправок funnel_sends (он же атомарный claim и
-- источник счётчиков бюджета) и ответы клиентов client_feedback. RLS
-- deny-by-default без позитивных политик — как у остальных user-таблиц
-- (инвариант 8). Частичные UNIQUE — дедуп на уровне БД: одноразовые сообщения
-- один раз на клиента, оценка — одна на заказ (первый клик побеждает).
CREATE TABLE "client_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"order_id" uuid,
	"kind" text NOT NULL,
	"score" smallint,
	"answer" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_feedback_score_range" CHECK ("client_feedback"."score" IS NULL OR ("client_feedback"."score" >= 1 AND "client_feedback"."score" <= 5))
);
--> statement-breakpoint
ALTER TABLE "client_feedback" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "funnel_sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"order_id" uuid,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "funnel_sends" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "funnel_opt_out_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "client_feedback" ADD CONSTRAINT "client_feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_feedback" ADD CONSTRAINT "client_feedback_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funnel_sends" ADD CONSTRAINT "funnel_sends_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funnel_sends" ADD CONSTRAINT "funnel_sends_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "client_feedback_user_id_idx" ON "client_feedback" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "client_feedback_kind_created_at_idx" ON "client_feedback" USING btree ("kind","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "client_feedback_survey_once_per_user_idx" ON "client_feedback" USING btree ("user_id","kind") WHERE "client_feedback"."kind" IN ('expired_survey', 'start_survey');--> statement-breakpoint
CREATE UNIQUE INDEX "client_feedback_rating_once_per_order_idx" ON "client_feedback" USING btree ("order_id") WHERE "client_feedback"."kind" = 'order_rating' AND "client_feedback"."order_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "funnel_sends_user_id_sent_at_idx" ON "funnel_sends" USING btree ("user_id","sent_at");--> statement-breakpoint
CREATE UNIQUE INDEX "funnel_sends_once_per_user_idx" ON "funnel_sends" USING btree ("user_id","kind") WHERE "funnel_sends"."kind" IN ('expired_survey', 'start_survey', 'referral_nudge');--> statement-breakpoint
CREATE UNIQUE INDEX "funnel_sends_rating_once_per_order_idx" ON "funnel_sends" USING btree ("order_id") WHERE "funnel_sends"."kind" = 'order_rating' AND "funnel_sends"."order_id" IS NOT NULL;