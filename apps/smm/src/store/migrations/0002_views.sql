-- Просмотры постов канала (тикет 11).
--
-- Снимки, а не одно поле: витрина добирает цифру день-два, и «сколько было
-- через сутки» — единственный честный способ сравнивать посты между собой.
CREATE TABLE views_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id TEXT NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  views INTEGER NOT NULL,
  taken_at TEXT NOT NULL
);

CREATE INDEX views_snapshots_post_idx ON views_snapshots (post_id, taken_at);

-- Сторож снятых постов: пост, пропавший с витрины, считается удалённым не с
-- первого раза. Витрина отдаёт последние посты страницами и в момент прогона
-- может просто не показать старый — одного пропуска мало.
CREATE TABLE withdraw_watch (
  post_id TEXT PRIMARY KEY REFERENCES posts (id) ON DELETE CASCADE,
  misses INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
