ALTER TABLE "services" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "services_public_read_active" ON "services";
--> statement-breakpoint
CREATE POLICY "services_public_read_active"
ON "services"
FOR SELECT
TO anon, authenticated
USING ("is_active" = true);
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
ON "services"
FROM anon, authenticated;
--> statement-breakpoint
GRANT SELECT
ON "services"
TO anon, authenticated;
