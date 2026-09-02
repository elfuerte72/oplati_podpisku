-- История правок текстов воронки — append-only на уровне БД (спека
-- .scratch/admin-panel-v2/, ветка C, тикет 09), по образцу
-- order_events_append_only (0018): «кто, когда, что было» нельзя переписать
-- и нельзя стереть даже через service_role — RLS его обходит, а триггер нет.
-- Отдельным файлом от сгенерированного 0043: триггеры Drizzle не описывает,
-- и смешивать рукописное с генерируемым значит потерять регенерацию
-- (тот же довод, что у 0029). `SET search_path = ''` — хардненинг 0021.
CREATE OR REPLACE FUNCTION forbid_funnel_text_revisions_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'funnel_text_revisions is append-only: % blocked', TG_OP;
END
$$ LANGUAGE plpgsql SET search_path = '';--> statement-breakpoint
CREATE TRIGGER funnel_text_revisions_append_only
BEFORE UPDATE OR DELETE ON "funnel_text_revisions"
FOR EACH ROW EXECUTE FUNCTION forbid_funnel_text_revisions_mutation();
