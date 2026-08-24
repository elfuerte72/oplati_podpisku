CREATE TABLE "vcc_fund_reservations" (
	"order_id" uuid PRIMARY KEY NOT NULL,
	"amount_usd_cents" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vcc_fund_reservations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "vcc_fund_reservations" ADD CONSTRAINT "vcc_fund_reservations_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vcc_fund_reservations_expires_at_idx" ON "vcc_fund_reservations" USING btree ("expires_at");