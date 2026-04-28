-- Идемпотентная миграция: синхронизирует drizzle-kit snapshot с реальной БД.
-- RLS на этих 4 таблицах уже включён миграцией 0001_enable_rls.sql.
-- Эта миграция нужна потому что .enableRLS() добавлен в schema.ts позже;
-- без неё `db:push` каждый раз предлагал бы DISABLE ROW LEVEL SECURITY,
-- считая RLS «лишним» (snapshot 0001 о нём не знал).
-- ALTER TABLE ... ENABLE ROW LEVEL SECURITY идемпотентна — повторное применение
-- не меняет состояние БД. Применена через Supabase MCP, чтобы записать факт
-- в supabase_migrations.schema_migrations (audit trail).
ALTER TABLE "conversations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "staff" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;