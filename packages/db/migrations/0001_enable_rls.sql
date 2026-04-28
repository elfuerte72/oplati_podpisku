-- ENABLE RLS для всех 4 таблиц с пользовательскими данными.
-- Политики (operator/supervisor/admin) добавятся в milestone «Минимальная админка»
-- (Sprint 2). Пока service_role обходит RLS — server-only код работает.
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "staff" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "conversations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;
