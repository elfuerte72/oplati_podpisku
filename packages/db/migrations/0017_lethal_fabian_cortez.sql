DROP INDEX "referral_accruals_payment_beneficiary_level_idx";--> statement-breakpoint
-- Перед созданием частичного unique гасим исторические дубли: если у заказа
-- несколько pending-платежей (доиндексная гонка confirm_order), оставляем
-- самый свежий, старшие переводим в failed (их инвойсы уже истекли/мертвы).
UPDATE "payments" p SET "status" = 'failed', "completed_at" = now()
WHERE p."status" = 'pending' AND EXISTS (
  SELECT 1 FROM "payments" p2
  WHERE p2."order_id" = p."order_id" AND p2."status" = 'pending'
    AND (p2."created_at" > p."created_at" OR (p2."created_at" = p."created_at" AND p2."id" > p."id"))
);--> statement-breakpoint
CREATE UNIQUE INDEX "payments_one_pending_per_order_idx" ON "payments" USING btree ("order_id") WHERE "payments"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "referral_accruals_payment_beneficiary_level_idx" ON "referral_accruals" USING btree ("payment_id","beneficiary_user_id","level") WHERE "referral_accruals"."status" = 'accrued';