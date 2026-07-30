-- Поведенческая аналитика: защита от переписывания истории + вьюхи отчётов.
--
-- Отдельной миграцией от 0028 (создание таблиц) намеренно: DDL таблиц
-- генерируется Drizzle из schema.ts, а триггеры и вьюхи Drizzle не описывает —
-- смешивать сгенерированное с рукописным в одном файле значит потерять
-- возможность регенерировать первое.
--
-- ВАЖНО про права: вьюхи создаются владельцем БД и выполняются с его правами
-- (обычная view в Postgres, без security_invoker). Именно поэтому роль
-- `metabase_ro` получит доступ к путям клиентов через GRANT на ВЬЮХУ, не имея
-- грантов на колонки `users` (`telegram_id`/`web_session_id` ей не выданы —
-- см. docs/runbooks/metabase.md). Наружу отдаётся ровно то, что перечислено
-- в вьюхе, и ничего больше.

-- ─── История событий неизменяема ─────────────────────────────────────────
-- UPDATE запрещён: событие — факт прошлого, его смысл не меняется (это же
-- гарантирует, что резолв личности остаётся JOIN'ом, а не backfill'ом).
-- DELETE разрешён, в отличие от `order_events`: аналитику чистит cron
-- `retention`, а аудит-след денег не чистится никогда.
CREATE OR REPLACE FUNCTION analytics_events_no_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'analytics_events is append-only: UPDATE is not allowed';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER analytics_events_append_only
  BEFORE UPDATE ON analytics_events
  FOR EACH ROW EXECUTE FUNCTION analytics_events_no_update();
--> statement-breakpoint

-- ─── Единая лента: телеметрия + денежные вехи ────────────────────────────
-- Вехи НЕ дублируются телеметрией — они читаются отсюда, из таблиц, где уже
-- записаны в одной транзакции с деньгами. Побочный эффект: отчёты показывают
-- историю за всё прошлое, а не с момента включения аналитики.
--
-- `subject_key` — то, по чему считается воронка. Анонимный визит опознаётся
-- своей cookie, после привязки Telegram те же события схлопываются к user_id
-- (JOIN находит строку `users` с этим `web_session_id`) — ретроспективно и без
-- единого UPDATE.
CREATE VIEW analytics_timeline AS
  -- Собственная телеметрия
  SELECT
    e.occurred_at,
    e.name,
    'event'::text                                   AS kind,
    e.channel,
    u.id                                            AS user_id,
    COALESCE(u.telegram_id, e.telegram_id)          AS telegram_id,
    e.web_session_id,
    e.order_id,
    o.short_id                                      AS order_ref,
    e.props,
    COALESCE(u.id::text, 'web:' || e.web_session_id, 'tg:' || e.telegram_id) AS subject_key
  FROM analytics_events e
  LEFT JOIN users u
    ON (e.web_session_id IS NOT NULL AND u.web_session_id = e.web_session_id)
    OR (e.telegram_id IS NOT NULL AND u.telegram_id = e.telegram_id)
  LEFT JOIN orders o ON o.id = e.order_id

  UNION ALL

  -- Денежные вехи заказа: order_events — источник правды (инвариант 1)
  SELECT
    oe.created_at                                   AS occurred_at,
    CASE oe.event_type
      WHEN 'order_created'            THEN 'order_proposed'
      WHEN 'payment_invoice_created'  THEN 'invoice_sent'
      WHEN 'payment_succeeded'        THEN 'payment_paid'
      WHEN 'fulfillment_completed'    THEN 'card_issued'
      WHEN 'subscription_activated'   THEN 'subscription_paid'
      WHEN 'payment_issue_reported'   THEN 'payment_issue'
      WHEN 'order_expired'            THEN 'order_expired'
    END                                             AS name,
    'milestone'::text                               AS kind,
    'derived'::text                                 AS channel,
    o.user_id,
    u.telegram_id,
    u.web_session_id,
    o.id                                            AS order_id,
    o.short_id                                      AS order_ref,
    jsonb_strip_nulls(jsonb_build_object(
      'amount_kopecks', o.amount_rub,
      'amount_usd_cents', o.original_amount
    ))                                              AS props,
    o.user_id::text                                 AS subject_key
  FROM order_events oe
  JOIN orders o ON o.id = oe.order_id
  LEFT JOIN users u ON u.id = o.user_id
  WHERE oe.event_type IN (
    'order_created', 'payment_invoice_created', 'payment_succeeded',
    'fulfillment_completed', 'subscription_activated', 'payment_issue_reported',
    'order_expired'
  )

  UNION ALL

  -- Привязка Telegram — наш крупнейший гейт (без неё оплата недоступна)
  SELECT
    lt.used_at                                      AS occurred_at,
    'telegram_linked'::text                         AS name,
    'milestone'::text                               AS kind,
    'derived'::text                                 AS channel,
    u.id                                            AS user_id,
    lt.telegram_id,
    lt.web_session_id,
    NULL::uuid                                      AS order_id,
    NULL::text                                      AS order_ref,
    NULL::jsonb                                     AS props,
    COALESCE(u.id::text, 'web:' || lt.web_session_id) AS subject_key
  FROM link_tokens lt
  LEFT JOIN users u ON u.telegram_id = lt.telegram_id
  WHERE lt.used_at IS NOT NULL

  UNION ALL

  -- Выдача VPN-подписки
  SELECT
    v.created_at                                    AS occurred_at,
    'vpn_link_issued'::text                         AS name,
    'milestone'::text                               AS kind,
    'derived'::text                                 AS channel,
    v.user_id,
    v.telegram_id,
    u.web_session_id,
    NULL::uuid                                      AS order_id,
    NULL::text                                      AS order_ref,
    NULL::jsonb                                     AS props,
    v.user_id::text                                 AS subject_key
  FROM vpn_subscriptions v
  LEFT JOIN users u ON u.id = v.user_id;
--> statement-breakpoint

-- ─── Путь пользователя: подписи, паузы, сессии ───────────────────────────
-- Сессия НЕ хранится в данных, а вычисляется по разрыву 30 минут: решение
-- «считать сессию другой длины» становится правкой запроса, а не перезаписью
-- накопленного. В боте понятия сессии нет вовсе — так оно появляется
-- одинаково для всех каналов.
-- Два прохода (CTE + внешний SELECT), а не одно выражение: Postgres запрещает
-- вложенные оконные функции, а признак новой сессии считается ИЗ паузы,
-- которая сама вычисляется окном.
CREATE VIEW analytics_user_path AS
  WITH paused AS (
    SELECT
      t.occurred_at,
      t.subject_key,
      t.user_id,
      t.telegram_id,
      t.web_session_id,
      t.channel,
      t.kind,
      t.name,
      COALESCE(d.title, t.name)                     AS title,
      d.description,
      d.funnel_step,
      t.order_ref,
      t.props,
      t.occurred_at - lag(t.occurred_at) OVER w     AS pause
    FROM analytics_timeline t
    LEFT JOIN analytics_event_types d ON d.name = t.name
    WHERE t.subject_key IS NOT NULL
    WINDOW w AS (PARTITION BY t.subject_key ORDER BY t.occurred_at)
  )
  SELECT
    p.*,
    sum(CASE WHEN p.pause IS NULL OR p.pause > interval '30 minutes' THEN 1 ELSE 0 END)
      OVER (PARTITION BY p.subject_key ORDER BY p.occurred_at
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS session_no
  FROM paused p;
--> statement-breakpoint

-- ─── Воронка: сколько субъектов дошло до каждого шага ────────────────────
-- Считает по `subject_key`, поэтому анонимный верх воронки и опознанный низ
-- сходятся в одну цепочку после привязки Telegram.
CREATE VIEW analytics_funnel AS
  SELECT
    d.funnel_step                                   AS step,
    d.name,
    d.title,
    count(DISTINCT t.subject_key)                   AS subjects,
    min(t.occurred_at)                              AS first_seen,
    max(t.occurred_at)                              AS last_seen
  FROM analytics_event_types d
  LEFT JOIN analytics_timeline t ON t.name = d.name
  WHERE d.funnel_step IS NOT NULL
  GROUP BY d.funnel_step, d.name, d.title
  ORDER BY d.funnel_step;
