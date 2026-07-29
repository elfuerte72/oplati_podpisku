-- УДАЛЕНО ВРУЧНУЮ: ALTER TYPE payment_provider ADD VALUE 'freekassa'.
--
-- Значение уже добавлено миграцией 0025 (написанной руками, с IF NOT EXISTS,
-- поэтому в снапшоты drizzle оно не попало — отсюда и повторная генерация).
-- Оставить строку было нельзя дважды: без IF NOT EXISTS повторное применение
-- падает с «already exists» и обрывает всю миграцию, а ADD VALUE в одной
-- транзакции с прочим DDL — та самая грабля из CLAUDE.md.
-- Снапшот 0027 значение уже содержит, так что следующие генерации чистые.
ALTER TABLE "referral_monthly_stats" ALTER COLUMN "network_turnover_usd_cents" SET DATA TYPE bigint;--> statement-breakpoint
CREATE INDEX "messages_created_at_idx" ON "messages" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "order_events_event_type_created_at_idx" ON "order_events" USING btree ("event_type","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "order_events_renewal_reminder_once_idx" ON "order_events" USING btree ("order_id") WHERE "order_events"."event_type" = 'renewal_reminder_sent';--> statement-breakpoint
CREATE INDEX "payments_created_at_idx" ON "payments" USING btree ("created_at");