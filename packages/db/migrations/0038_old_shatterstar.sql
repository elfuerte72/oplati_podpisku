ALTER TABLE "staff" DROP CONSTRAINT IF EXISTS "staff_auth_user_id_unique";--> statement-breakpoint
ALTER TABLE "staff" DROP COLUMN "auth_user_id";