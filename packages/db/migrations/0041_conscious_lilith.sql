-- Режим разговора: третье значение `idle` («никто не отвечает»), срок жизни
-- режима и backfill существующих строк.
--
-- ⚠️ Значение enum добавляется ПЕРЕСОЗДАНИЕМ ТИПА, а не `ALTER TYPE ADD VALUE`,
-- и это не украшательство. Postgres запрещает использовать значение enum в той
-- же транзакции, где оно добавлено к СУЩЕСТВУЮЩЕМУ типу, — а drizzle-мигратор
-- оборачивает в ОДНУ транзакцию ВСЕ ожидающие миграции разом
-- (`PgDialect.migrate`: `session.transaction(...)` вокруг цикла по файлам), а
-- не каждый файл по отдельности. Разнести `ADD VALUE` и его использование по
-- двум файлам поэтому НЕ помогает: если оба ждут применения (обычный случай
-- инкрементального обновления dev-базы), они всё равно едут одной транзакцией
-- и падают с `unsafe use of new value "idle" of enum type`.
--
-- На тип, СОЗДАННЫЙ в текущей транзакции, запрет не распространяется — отсюда
-- rename + create + swap. Проверено тестом, который гоняет настоящий
-- drizzle-мигратор поверх базы, уже накатанной до предыдущей миграции.
--
-- Таблица маленькая (один разговор на клиента), переписывание колонки берёт
-- ACCESS EXCLUSIVE на миллисекунды.
ALTER TABLE "conversations" ALTER COLUMN "handoff_mode" DROP DEFAULT;--> statement-breakpoint
ALTER TYPE "public"."handoff_mode" RENAME TO "handoff_mode_old";--> statement-breakpoint
CREATE TYPE "public"."handoff_mode" AS ENUM('idle', 'ai', 'operator');--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "handoff_mode" TYPE "public"."handoff_mode" USING "handoff_mode"::text::"public"."handoff_mode";--> statement-breakpoint
DROP TYPE "public"."handoff_mode_old";--> statement-breakpoint
-- Дефолт был `ai` с самого начала, но поле НИКТО не читал: бот отвечал всем
-- одинаково. С появлением помощника дефолт `ai` означал бы «с каждым новым
-- клиентом уже открыта сессия помощника» — то есть вход в поддержку мимо
-- кнопки (правило В3).
ALTER TABLE "conversations" ALTER COLUMN "handoff_mode" SET DEFAULT 'idle';--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "mode_expires_at" timestamp with time zone;--> statement-breakpoint
-- Крон хозяйства поддержки ищет истёкшие режимы раз в 15 минут, а таблица
-- ретеншеном не чистится: без индекса это seq scan по всей истории клиентов.
CREATE INDEX "conversations_mode_expires_at_idx" ON "conversations" USING btree ("mode_expires_at");--> statement-breakpoint
-- Строки с ведущим оператором (`operator`) не трогаем — там человек в диалоге.
UPDATE "conversations" SET "handoff_mode" = 'idle' WHERE "handoff_mode" = 'ai';
