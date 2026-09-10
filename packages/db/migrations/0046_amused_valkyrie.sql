-- Оплата заказа реферальными баллами (спека .scratch/referral-balance-spend/,
-- тикет 01): списание — СОСТОЯНИЕ (одна строка на заказ), а не строка в
-- append-only ledger'е начислений, где CHECK amount >= 0 делает «отрицательную
-- строку» невозможной by design, а новый kind испортил бы витрины дохода.
--
-- Enum создаётся С НУЛЯ, поэтому ловушка `ALTER TYPE ADD VALUE` из CLAUDE.md
-- здесь не действует: запрет касается значений, добавленных к СУЩЕСТВУЮЩЕМУ
-- типу в той же транзакции.
--
-- RLS deny-by-default без позитивных политик — как у остальных user-таблиц
-- (инвариант 8). PK по order_id даёт «не более одного списания на заказ»
-- бесплатно и делает занятие идемпотентным.
CREATE TYPE "public"."referral_redemption_status" AS ENUM('reserved', 'spent', 'released');--> statement-breakpoint
CREATE TABLE "referral_redemptions" (
	"order_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"amount_usd_cents" integer NOT NULL,
	"discount_kopecks" integer NOT NULL,
	"rate_kopecks" integer NOT NULL,
	"status" "referral_redemption_status" DEFAULT 'reserved' NOT NULL,
	"released_by" uuid,
	"reserved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "referral_redemptions_amount_positive" CHECK ("referral_redemptions"."amount_usd_cents" > 0),
	CONSTRAINT "referral_redemptions_discount_positive" CHECK ("referral_redemptions"."discount_kopecks" > 0)
);
--> statement-breakpoint
ALTER TABLE "referral_redemptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "referral_redemptions" ADD CONSTRAINT "referral_redemptions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_redemptions" ADD CONSTRAINT "referral_redemptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_redemptions" ADD CONSTRAINT "referral_redemptions_released_by_staff_id_fk" FOREIGN KEY ("released_by") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "referral_redemptions_user_idx" ON "referral_redemptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "referral_redemptions_released_by_idx" ON "referral_redemptions" USING btree ("released_by");