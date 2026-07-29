import { NextResponse } from 'next/server';

import { getAppliedMigrations, getDb, pingDb } from '@oplati/db';
import journal from '@oplati/db/migrations-journal';

import { childLogger } from '@/lib/logger';

/**
 * Readiness — «этот релиз действительно работоспособен?».
 *
 * Отдельно от `/api/health` намеренно. `/api/health` — liveness: его дёргает
 * Docker HEALTHCHECK, и завязывать его на БД нельзя, иначе моргнувшая база
 * начнёт перезапускать контейнеры и превратит короткий сбой в даун. Readiness
 * же зовёт пайплайн деплоя ОДИН раз после выкатки, и ему нужна ровно обратная
 * строгость.
 *
 * Проверяем две вещи, каждая из которых уже стоила проду инцидента:
 *
 *  1. **БД отвечает.** `DATABASE_URL` в env-схеме опциональный, а имя сервиса
 *     Postgres меняется при пересоздании (`oplatishka-db-<хеш>`): опечатка в
 *     хосте оставляла контейнер `healthy`, релиз докатывался, и падал уже
 *     клиентский путь заказ→оплата.
 *  2. **Миграции применены.** Пайплайн их не гоняет — это ручной шаг. 2026-07-28
 *     он потерялся: код Freekassa уехал в main 26.07, миграции 0025/0026 на
 *     прод не попали, и первый счёт упал с `relation "freekassa_nonce" does not
 *     exist` — при зелёном деплое, здоровом `/api/health` и без единого алёрта
 *     (docs/incidents.md). Схема «код уехал, миграция нет» не ловилась ничем,
 *     кроме первого пострадавшего клиента.
 *
 * Журнал `_journal.json` запекается в бандл на сборке, поэтому эндпоинт
 * сравнивает ИМЕННО тот набор миграций, что приехал вместе с этим кодом.
 *
 * Наружу отдаём только грубый код причины, без хешей, счётчиков и имён
 * миграций: репозиторий публичный, и точное соответствие «прод ↔ строки кода»
 * раскрывать незачем (та же логика, что у `/api/health`, который не отдаёт git
 * SHA). Подробности — в лог.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const preferredRegion = 'fra1';
export const maxDuration = 10;

const log = childLogger('api.ready');

/** Самая свежая миграция, приехавшая с этим образом. */
const EXPECTED = {
  count: journal.entries.length,
  latestWhen: journal.entries.reduce((max, e) => Math.max(max, e.when), 0),
};

type Reason = 'db_unreachable' | 'migrations_pending' | 'migrations_ahead';

export async function GET(): Promise<NextResponse> {
  const reasons: Reason[] = [];

  try {
    const db = getDb();
    await pingDb(db);

    const applied = await getAppliedMigrations(db);
    if (applied.latestWhen === null || applied.latestWhen < EXPECTED.latestWhen) {
      reasons.push('migrations_pending');
      log.error({
        event: 'api.ready.migrations_pending',
        expectedCount: EXPECTED.count,
        expectedLatestWhen: EXPECTED.latestWhen,
        appliedCount: applied.count,
        appliedLatestWhen: applied.latestWhen,
      });
    } else if (applied.latestWhen > EXPECTED.latestWhen) {
      // БД впереди кода: нормальная середина отката (миграции forward-only, их
      // не откатывают). Не «всё хорошо», но и не «релиз сломан» — отдельный код,
      // чтобы это не читалось как забытый db:migrate.
      reasons.push('migrations_ahead');
      log.warn({
        event: 'api.ready.migrations_ahead',
        expectedLatestWhen: EXPECTED.latestWhen,
        appliedLatestWhen: applied.latestWhen,
      });
    }
  } catch (err) {
    // Недоступна БД ИЛИ нет схемы `drizzle` вовсе — для готовности релиза это
    // одинаково «не готов»; различать здесь нечего, детали в логе.
    reasons.push('db_unreachable');
    log.error({ event: 'api.ready.db_failed', err });
  }

  if (reasons.length === 0) {
    return NextResponse.json({ status: 'ok' }, { status: 200 });
  }
  return NextResponse.json({ status: 'degraded', reasons }, { status: 503 });
}
