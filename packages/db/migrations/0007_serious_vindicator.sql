CREATE TABLE "link_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token" text NOT NULL,
	"web_session_id" text NOT NULL,
	"telegram_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "link_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "link_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "link_tokens_web_session_id_idx" ON "link_tokens" USING btree ("web_session_id");