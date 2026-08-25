# Рунбук: бэкапы и восстановление БД

Прод-БД — self-hosted Postgres 17 `oplatishka-db` (контейнер
`oplatishka-db-ry3smb`) на VPS `187.124.172.104`. Наружу порт не опубликован
(`externalPort: null`) — только внутренняя сеть Docker и `docker exec`.

---

## Что настроено

Нативный бэкап Dokploy → Cloudflare R2, **03:00 UTC ежедневно, keep 14**.

- бакет `dokploy-backups`, endpoint `…r2.cloudflarestorage.com`
- ключ объекта: `oplatishka-db-ry3smb/oplatishka-db/<ISO>.sql.gz`
- **RPO 24 ч.** Между дампами теряется до суток заказов и платежей — см. пункт
  про PITR в [`../BACKLOG.md`](../BACKLOG.md).

⚠️ **Формат — `pg_dump -Fc` (custom), несмотря на расширение `.sql.gz`.**
Восстанавливать `pg_restore`; привычное `psql < dump.sql` просто упадёт.

⚠️ **Размер — индикатор осмысленности дампа.** Дамп со структурой и каталогом, но
без клиентских данных весит ~13 КБ; полный на 2026-07-25 — ~333 КБ. Если очередной
бэкап резко «похудел» — сначала проверять, ту ли базу он снял.

---

## Ручной бэкап

Через панель Dokploy (`oplatishka-db` → Backups → Run) либо API:

```bash
curl -X POST -H "x-api-key: $DOKPLOY_API_KEY" -H 'content-type: application/json' \
  -d '{"backupId":"gdM60msSyECSo0BZp9bQn"}' \
  https://dokploypanel.oplatishka.com/api/backup.manualBackupPostgres
```

Проверить, что залилось (лог пишет `✅ Upload to S3 completed successfully`):

```bash
ssh root@187.124.172.104 'tail -8 "$(ls -t /etc/dokploy/logs/backup-navigate-open-source-program-u4xwur/*.log | head -1)"'
```

---

## Учение по восстановлению

Прогонять после значимых изменений схемы и хотя бы раз в квартал. Ниже — ровно то,
что отработано 2026-07-25 (данные совпали с продом до копейки).

**1. Скачать артефакт из R2.** rclone уже есть внутри контейнера Dokploy —
отдельный клиент ставить не нужно. Креды — в Dokploy → Destinations →
`postgresql_backup`.

```bash
ssh root@187.124.172.104
C=$(docker ps --format '{{.Names}}' | grep -i '^dokploy\.' | head -1)
RC="docker exec -e RCLONE_CONFIG_R2_TYPE=s3 -e RCLONE_CONFIG_R2_PROVIDER=Cloudflare \
  -e RCLONE_CONFIG_R2_ACCESS_KEY_ID=<key> -e RCLONE_CONFIG_R2_SECRET_ACCESS_KEY=<secret> \
  -e RCLONE_CONFIG_R2_ENDPOINT=<endpoint> -e RCLONE_CONFIG_R2_REGION=auto $C rclone"

$RC lsl r2:dokploy-backups/oplatishka-db-ry3smb | sort -k2,3 | tail -5   # выбрать свежий
$RC cat "r2:dokploy-backups/oplatishka-db-ry3smb/oplatishka-db/<ISO>.sql.gz" > /tmp/restore.sql.gz
gunzip -t /tmp/restore.sql.gz && echo "gzip OK"
```

**2. Восстановить в ОТДЕЛЬНУЮ базу** (не в `oplatishka`!) того же инстанса:

```bash
PG=$(docker ps --filter name=oplatishka-db-ry3smb --format '{{.ID}}' | head -1)
docker exec "$PG" psql -U oplatishka -d postgres -q -c "CREATE DATABASE oplatishka_restore_test;"
gunzip -c /tmp/restore.sql.gz | docker exec -i "$PG" \
  pg_restore -U oplatishka -d oplatishka_restore_test --no-owner
```

**3. Сверить с продом — не только COUNT'ы.** Совпадение счётчиков не доказывает,
что переехали защиты: `psql` без `ON_ERROR_STOP` продолжает после упавших
операторов, и restore может «пройти успешно» без триггера или политик.

```bash
Q="select (select count(*) from orders) orders, (select count(*) from messages) msg,
   (select count(*) from payments) pay, (select count(*) from users) usr,
   (select count(*) from order_events) ev, (select count(*) from conversations) conv,
   (select count(*) from services) svc, (select coalesce(sum(amount_rub),0) from payments) sum_kop"
docker exec "$PG" psql -U oplatishka -d oplatishka             -tAc "$Q"
docker exec "$PG" psql -U oplatishka -d oplatishka_restore_test -tAc "$Q"

# инварианты: триггер, RLS, политика каталога, журнал миграций
docker exec "$PG" psql -U oplatishka -d oplatishka_restore_test -tAc \
  "select tgname, tgenabled from pg_trigger where not tgisinternal"
docker exec "$PG" psql -U oplatishka -d oplatishka_restore_test -tAc \
  "select count(*) filter (where relrowsecurity), count(*) from pg_class c
   join pg_namespace n on n.oid=c.relnamespace where n.nspname=current_schema() and c.relkind='r'"
docker exec "$PG" psql -U oplatishka -d oplatishka_restore_test -tAc "select tablename, policyname from pg_policies"
docker exec "$PG" psql -U oplatishka -d oplatishka_restore_test -tAc "select count(*) from drizzle.__drizzle_migrations"

# триггер должен РЕАЛЬНО блокировать, а не просто существовать
docker exec "$PG" psql -U oplatishka -d oplatishka_restore_test -tAc \
  "update order_events set event_type='x' where id=(select id from order_events limit 1)"
# ожидаем: ERROR ... append-only: UPDATE blocked (invariant #1)
```

Эталон на 2026-08-25: суммы совпали, 21 таблица, RLS 21/21, политика
`services_public_read_active`, 41 миграция, `UPDATE order_events` отбит.
(Предыдущая сверка 2026-07-25: 17 таблиц, 25 миграций.)

Новые таблицы `pg_dump -Fc` забирает сам — ручных шагов, как с
последовательностью `freekassa_nonce`, не требуется. После восстановления снимок
карточного фонда перепишет крон в течение 5 минут, а занятые резервы протухнут
за срок счёта (час), поэтому расхождение по ним не страшно.

**4. Убрать за собой:**

```bash
docker exec "$PG" psql -U oplatishka -d postgres -q -c "DROP DATABASE oplatishka_restore_test;"
rm -f /tmp/restore.sql.gz
```

---

## Реальное восстановление прода

Отличается от учения только целью. Порядок:

1. **Остановить приложение**, чтобы оно не писало в БД во время восстановления
   (Dokploy → `oplatishka-web` → Stop).
2. Восстановить в новую базу (`oplatishka_new`), сверить по чек-листу выше.
3. Переименовать: `oplatishka` → `oplatishka_broken`, `oplatishka_new` →
   `oplatishka`. Так старая база остаётся под рукой.
4. Запустить приложение, прогнать смоук из [`deploy.md`](deploy.md).
5. **Проверить `db:init-roles`**: если восстанавливаем в чистый инстанс, роли
   `anon`/`authenticated`/`service_role` должны существовать ДО миграций, иначе
   миграция 0010 упадёт на `GRANT`. Приоритет env у скрипта тот же, что у
   `drizzle.config` (`DATABASE_URL_DIRECT ?? DATABASE_URL`).

6. **Вернуть GRANT'ы на каталог (A-5).** Дамп снимается с `--no-acl`, поэтому
   `GRANT SELECT ON services TO anon, authenticated` из миграции 0010 в него не
   попадает, а повторно миграция не прогонится — журнал считает её применённой.
   Сегодня это инертно (роли `NOLOGIN`, браузерного anon-клиента нет), и
   направление безопасное — fail-closed, «не видно» вместо «видно лишнее».
   Но пункт обязателен в чек-листе: в день, когда появится клиентский запрос к
   каталогу, витрина молча опустеет, и связать это с восстановлением месячной
   давности будет практически невозможно.

   ```bash
   # проверить
   ssh root@187.124.172.104 "docker exec \$(docker ps --filter name=oplatishka-db-ry3smb -q) \
     psql -U oplatishka -d oplatishka -t -A -c \
     \"select grantee, privilege_type from information_schema.role_table_grants
       where table_name='services' and grantee in ('anon','authenticated')\""

   # вернуть, если пусто
   ssh root@187.124.172.104 "docker exec \$(docker ps --filter name=oplatishka-db-ry3smb -q) \
     psql -U oplatishka -d oplatishka -c \
     'GRANT SELECT ON TABLE services TO anon, authenticated'"
   ```

---

## Резервная копия эпохи Supabase

Прод-Supabase `nyxijwpuvctmvemaemqn` содержит данные на момент cutover (2026-07-24) и
**гасится** — владелец подтвердил 2026-08-14, что контур живёт на одном Dokploy + PostgreSQL.
⚠️ Перед удалением снять финальный дамп: после этого единственная копия данных той эпохи —
он. Порядок — [`rollback.md`](rollback.md).
