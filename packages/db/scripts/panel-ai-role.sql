-- Роль `panel_ai_ro` — подключение AI-аналитика админ-панели (спека
-- `.scratch/admin-panel-v2/`, ветка B; ADR 0003).
--
-- Аналитик пишет SQL сам и выполняет его через `runReadOnlyQuery`
-- (`packages/db/src/readonly-query.ts`). Защита — ГРАНТЫ и read-only
-- транзакция, а не промпт: модель физически не может ни изменить данные, ни
-- прочитать то, чего у роли нет.
--
-- Образец — `metabase_ro` (docs/runbooks/metabase.md): те же таблицы и те же
-- колоночные ограничения, плюс две таблицы воронки (`client_feedback`,
-- `funnel_sends`) и вьюхи аналитики. Отличия от metabase_ro — в сторону
-- УЖЕСТОЧЕНИЯ, потому что читатель здесь не человек, а внешний провайдер модели:
--   - `staff` — без `totp_secret`/`totp_last_step` (второй фактор входа в
--     панель), без `email`/`telegram_id` (контакты персонала);
--   - `vpn_subscriptions` — без `subscription_url` (ссылка даёт доступ к VPN).
--
-- НЕ выдаётся: `messages` (переписка клиентов), `attachments`, `link_tokens`
-- (одноразовые токены привязки), сырая `analytics_events` (в ней
-- `web_session_id` — фактически пароль веб-сессии; вьюхи отдают хэш),
-- `users` сверх перечисленных колонок (email, телефон, IP, имя),
-- `payments.raw_payload`, `referral_payouts.destination`.
--
-- `ALTER DEFAULT PRIVILEGES` НЕ ставится намеренно (та же политика, что у
-- metabase_ro): новая таблица = явный грант, и словарь схемы в
-- `apps/web/lib/panel/ai/schema-dictionary.ts` обязан описывать ровно то, что
-- выдано здесь (зеркало ловится тестом `schema-dictionary.test.ts`).
--
-- BYPASSRLS обязателен: RLS включён на всех таблицах, а политик под обычную
-- роль нет (инвариант 8) — без него любой запрос вернул бы ноль строк.
-- Обходится только row-level фильтр; права остаются ровно выданными, запись
-- невозможна (нет грантов + read-only транзакции + `default_transaction_read_only`).
--
-- Применение (руками, на dev и проде — тикет 15): заменить <PASSWORD>
-- (`openssl rand -hex 24`), выполнить в psql контейнера БД, проверить:
--   \du panel_ai_ro
--   SET ROLE panel_ai_ro; SELECT count(*) FROM orders;   -- число
--   UPDATE orders SET status = status;                    -- read-only transaction
--   SELECT email FROM users;                              -- permission denied
-- Файл идемпотентен: роль создаётся один раз, гранты можно повторять.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'panel_ai_ro') THEN
    CREATE ROLE panel_ai_ro LOGIN PASSWORD '<PASSWORD>' CONNECTION LIMIT 2 BYPASSRLS;
  END IF;
END
$$;

ALTER ROLE panel_ai_ro SET default_transaction_read_only = on;
ALTER ROLE panel_ai_ro SET statement_timeout = '30s';

GRANT CONNECT ON DATABASE oplatishka TO panel_ai_ro;
GRANT USAGE ON SCHEMA public TO panel_ai_ro;

-- Таблицы целиком.
GRANT SELECT ON orders TO panel_ai_ro;
GRANT SELECT ON order_events TO panel_ai_ro;
GRANT SELECT ON services TO panel_ai_ro;
GRANT SELECT ON ai_usage_daily TO panel_ai_ro;
GRANT SELECT ON cards TO panel_ai_ro;
GRANT SELECT ON conversations TO panel_ai_ro;
GRANT SELECT ON referral_accruals TO panel_ai_ro;
GRANT SELECT ON referral_monthly_stats TO panel_ai_ro;
GRANT SELECT ON referral_partners TO panel_ai_ro;
GRANT SELECT ON client_feedback TO panel_ai_ro;
GRANT SELECT ON funnel_sends TO panel_ai_ro;
GRANT SELECT ON analytics_event_types TO panel_ai_ro;

-- Вьюхи аналитики: выполняются с правами владельца и отдают ровно то, что в
-- них перечислено (user_id, telegram_id, web_session_hash, событие, props).
GRANT SELECT ON analytics_timeline TO panel_ai_ro;
GRANT SELECT ON analytics_user_path TO panel_ai_ro;
GRANT SELECT ON analytics_funnel TO panel_ai_ro;

-- Колоночные гранты: контакты, секреты и сырые снимки провайдера не выдаются.
GRANT SELECT (id, language, created_at, updated_at, referred_by, referral_code, referred_by_set_at)
  ON users TO panel_ai_ro;
GRANT SELECT (id, order_id, provider, provider_ref, provider_invoice_number, amount_rub, status,
  last_provider_status, last_provider_status_at, recovered_via_polling, expires_at,
  webhook_received_at, created_at, completed_at)
  ON payments TO panel_ai_ro;
GRANT SELECT (id, user_id, amount_usd_cents, status, method, fee_usd_cents, requested_at, settled_at)
  ON referral_payouts TO panel_ai_ro;
GRANT SELECT (id, display_name, role, is_active, last_login_at, created_at)
  ON staff TO panel_ai_ro;
GRANT SELECT (id, user_id, telegram_id, remnawave_uuid, status, expire_at, created_at, updated_at)
  ON vpn_subscriptions TO panel_ai_ro;
