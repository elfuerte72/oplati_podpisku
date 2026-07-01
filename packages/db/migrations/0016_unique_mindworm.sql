CREATE TYPE "public"."referral_payout_method" AS ENUM('card_rub', 'crypto_usdt');--> statement-breakpoint
ALTER TABLE "referral_payouts" ADD COLUMN "method" "referral_payout_method";--> statement-breakpoint
ALTER TABLE "referral_payouts" ADD COLUMN "fee_usd_cents" integer;