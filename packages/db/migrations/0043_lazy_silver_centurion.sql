-- Тексты воронки обратной связи: оверлей над дефолтами из кода (спека
-- .scratch/admin-panel-v2/, ветка C, тикет 09). `funnel_texts` — строка есть
-- только у переопределённого ключа, нет строки → дефолт из templates.ts;
-- `funnel_text_revisions` — история правок, append-only триггером в 0044.
-- RLS deny-by-default без позитивных политик, как у остальных таблиц.
CREATE TABLE "funnel_text_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"old_value" text,
	"new_value" text,
	"staff_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "funnel_text_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "funnel_texts" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
ALTER TABLE "funnel_texts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "funnel_texts" ADD CONSTRAINT "funnel_texts_updated_by_staff_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "funnel_text_revisions_key_created_at_idx" ON "funnel_text_revisions" USING btree ("key","created_at");