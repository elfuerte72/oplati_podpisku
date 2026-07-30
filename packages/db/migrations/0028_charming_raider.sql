CREATE TABLE "analytics_event_types" (
	"name" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"channel" text NOT NULL,
	"origin" text NOT NULL,
	"funnel_step" integer,
	"kind" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "analytics_event_types" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "analytics_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_key" text NOT NULL,
	"name" text NOT NULL,
	"channel" text NOT NULL,
	"origin" text NOT NULL,
	"web_session_id" text,
	"telegram_id" text,
	"order_id" uuid,
	"props" jsonb,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "analytics_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "analytics_events_event_key_idx" ON "analytics_events" USING btree ("event_key");--> statement-breakpoint
CREATE INDEX "analytics_events_occurred_at_idx" ON "analytics_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "analytics_events_name_occurred_at_idx" ON "analytics_events" USING btree ("name","occurred_at");--> statement-breakpoint
CREATE INDEX "analytics_events_web_session_idx" ON "analytics_events" USING btree ("web_session_id","occurred_at") WHERE "analytics_events"."web_session_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "analytics_events_telegram_idx" ON "analytics_events" USING btree ("telegram_id","occurred_at") WHERE "analytics_events"."telegram_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "analytics_events_order_idx" ON "analytics_events" USING btree ("order_id") WHERE "analytics_events"."order_id" IS NOT NULL;