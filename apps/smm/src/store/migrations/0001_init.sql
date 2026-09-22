-- Состояние SMM-бота. Postgres прода не трогается: у бота своя SQLite в томе.
-- Forward-only: применённый файл не редактируется, изменение — новый файл.

-- Посты канала и Threads. Тело поста и досье лежат тут же: пост — единица
-- работы владельца, и его нельзя потерять из-за перезапуска процесса.
CREATE TABLE posts (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL CHECK (platform IN ('telegram', 'threads')),
  status TEXT NOT NULL,
  rubric TEXT,
  layout TEXT,
  angle TEXT,
  cta TEXT NOT NULL DEFAULT 'none' CHECK (cta IN ('none', 'soft', 'hard')),
  brief TEXT,
  source_url TEXT,
  source_title TEXT,
  dossier TEXT,
  body TEXT,
  -- Отпечаток тела. Оценка редактора и решение владельца относятся к КОНКРЕТНЫМ
  -- словам, а не к id поста: правка после «Опубликовать» обнуляет и то и другое.
  text_sha TEXT,
  image_path TEXT,
  -- Текст владельца дословно: редактор его не оценивает и не переписывает.
  owner_text INTEGER NOT NULL DEFAULT 0 CHECK (owner_text IN (0, 1)),
  judge TEXT,
  lint TEXT,
  rounds INTEGER NOT NULL DEFAULT 0,
  -- Threads: тема идёт параметром intent, а не решёткой в тексте.
  tag TEXT,
  button_text TEXT,
  button_url TEXT,
  channel_message_id INTEGER,
  -- Из какой идеи вырос пост (тикет 10) и из какого поста канала сделана версия
  -- для Threads (тикет 09): чтобы не качать статью и не считать досье заново.
  item_id TEXT,
  parent_post_id TEXT,
  -- Момент выхода по кнопке: окно отмены живёт в БД, а не только в setTimeout,
  -- иначе перезапуск процесса в это окно незаметно публикует или теряет пост.
  publish_at TEXT,
  previewed_at TEXT,
  published_at TEXT,
  withdrawn_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX posts_status_idx ON posts (status, updated_at);
CREATE INDEX posts_published_idx ON posts (platform, published_at);
CREATE INDEX posts_message_idx ON posts (channel_message_id);

-- Журнал решений: append-only. Гейт публикации читает именно его, а не поля
-- поста: клик по кнопке — факт, а поле можно перезаписать чем угодно.
CREATE TABLE decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id TEXT,
  kind TEXT NOT NULL,
  text_sha TEXT,
  actor TEXT NOT NULL CHECK (actor IN ('owner', 'code', 'model')),
  payload TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX decisions_post_idx ON decisions (post_id, id);

-- Append-only форсится триггерами, а не дисциплиной: образец —
-- order_events_append_only в проде. UPDATE и DELETE бросают исключение.
CREATE TRIGGER decisions_no_update BEFORE UPDATE ON decisions
BEGIN
  SELECT RAISE(ABORT, 'decisions append-only: UPDATE запрещён');
END;

CREATE TRIGGER decisions_no_delete BEFORE DELETE ON decisions
BEGIN
  SELECT RAISE(ABORT, 'decisions append-only: DELETE запрещён');
END;

-- Состояние диалога. Одна строка на владельца: бот обслуживает только его.
CREATE TABLE flow (
  owner_id INTEGER PRIMARY KEY,
  state TEXT NOT NULL,
  post_id TEXT,
  payload TEXT,
  -- Когда вопрос бота перестаёт ждать ответа. Истёкшее ожидание — idle, а не
  -- «бот ждал ответа неделю».
  expires_at TEXT,
  updated_at TEXT NOT NULL
);

-- Элементы источников (тикет 10). Дедуп по адресу первоисточника: один и тот же
-- материал приходит из канала, RSS и X одновременно.
CREATE TABLE items (
  id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL,
  source_ref TEXT,
  url TEXT NOT NULL UNIQUE,
  title TEXT,
  published_at TEXT,
  seen_at TEXT NOT NULL,
  rank TEXT,
  -- Решение владельца по идее: написали, пропустили, не по теме.
  verdict TEXT CHECK (verdict IS NULL OR verdict IN ('written', 'skipped', 'offtopic'))
);

CREATE INDEX items_seen_idx ON items (seen_at);
CREATE INDEX items_verdict_idx ON items (verdict);

-- Расход на модель. Деньги — целыми микродолларами: вызов стоит доли цента, и
-- сумма за месяц из float набирает ошибку там, где её никто не проверяет
-- (инвариант «деньги — integer в минимальных единицах»).
CREATE TABLE usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id TEXT,
  role TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_hit_tokens INTEGER NOT NULL DEFAULT 0,
  usd_micros INTEGER NOT NULL DEFAULT 0,
  is_peak INTEGER NOT NULL DEFAULT 0 CHECK (is_peak IN (0, 1)),
  -- 0 — тариф модели неизвестен, сумма посчитана по тарифу по умолчанию.
  price_known INTEGER NOT NULL DEFAULT 1 CHECK (price_known IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE INDEX usage_created_idx ON usage (created_at);
CREATE INDEX usage_post_idx ON usage (post_id);

-- Настройки времени работы: то, что владелец меняет через /settings.
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Темы, отмеченные владельцем как «не по теме»: идут исключениями в промпт
-- ранжирования, чтобы такое больше не предлагалось.
CREATE TABLE offtopic (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL
);
