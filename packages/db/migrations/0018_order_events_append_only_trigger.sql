-- Append-only для order_events теперь форсится САМОЙ БД (находка аудита S1):
-- RLS deny-by-default действует только на anon/authenticated, а весь серверный
-- код ходит через service_role/прямое подключение, которое RLS обходит — до
-- этого триггера инвариант №1 из CLAUDE.md держался на конвенции.
-- referral_accruals триггером НЕ покрываем: merge пользователей легитимно
-- обновляет beneficiary_user_id (consumeLinkToken).
CREATE OR REPLACE FUNCTION forbid_order_events_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'order_events is append-only: % blocked (invariant #1, CLAUDE.md)', TG_OP;
END
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER order_events_append_only
BEFORE UPDATE OR DELETE ON "order_events"
FOR EACH ROW EXECUTE FUNCTION forbid_order_events_mutation();
