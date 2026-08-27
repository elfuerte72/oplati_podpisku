import 'server-only';

import * as Sentry from '@sentry/nextjs';

import { countPendingOrdersForPanel, countUnansweredSupportRequests, getDb } from '@oplati/db';

import type { StaffRole } from '@oplati/db';

import { childLogger } from '@/lib/logger';

import { type MenuBadgeSection, type MenuCounts } from './desk';
import { canAccess } from './permissions';

/**
 * Числа для счётчиков меню и рабочего стола (редизайн, тикет 02).
 *
 * Считается ТЕМИ ЖЕ выборками, что питают рабочий стол, — второго определения
 * «ждёт оплаты» в панели быть не должно. Читатели ниже — единственная точка, где
 * эти выборки зовутся из витрины: стол и меню берут число отсюда, иначе один
 * запрос рабочего стола выполнялся бы дважды на каждый рендер.
 *
 * ⚠️ Оболочка рисуется на КАЖДОЙ странице панели, а живое обновление
 * перерисовывает её раз в 25 с в каждой открытой вкладке. Поэтому:
 *   - значение живёт `COUNT_TTL_MS` и переиспользуется всеми вкладками и
 *     всеми запросами процесса. Срок КОРОТКИЙ: он нужен, чтобы стол и меню
 *     одного рендера и вкладки, обновившиеся почти одновременно, делили один
 *     запрос, — а не чтобы число отставало от действия оператора (после
 *     ответа клиенту `router.refresh()` должен показать свежий счётчик);
 *   - параллельные вызовы делят один запрос — в памятке лежит ПРОМИС;
 *   - у запроса есть дедлайн: зависшая выборка гасит число, а не держит весь
 *     ответ страницы (тот же приём, что у чтения карточного счёта);
 *   - неудача НЕ запоминается: следующий рендер спрашивает снова, иначе один
 *     сбой держал бы стол на «не получили» весь срок памятки;
 *   - никогда не бросает: отказ базы — это `null` («не получили»), страница
 *     остаётся живой. Таймаут — только лог (база медленная), а НЕОЖИДАННЫЙ
 *     отказ запроса уходит в Sentry: «зелёная панель, мёртвый счётчик» — ровно
 *     та форма, в которой прошёл инцидент `freekassa_nonce`.
 */

const log = childLogger('panel.menu-counts');

const COUNT_TTL_MS = 5_000;
const COUNT_DEADLINE_MS = 2_000;

export type PendingTotals = { count: number; sumKopecks: number };

type Slot<T> = { promise: Promise<T | null>; at: number };

const memo: { pending?: Slot<PendingTotals>; support?: Slot<number> } = {};

/** Только для тестов: сбросить памятку между сценариями. */
export function resetMenuCountsMemoForTests(): void {
  delete memo.pending;
  delete memo.support;
}

/**
 * Дедлайн без отмены: postgres-js запрос не прервать, но ждать его дольше
 * бюджета страница не обязана — число гаснет, запрос дорабатывает в фоне.
 */
function withDeadline<T>(section: keyof typeof memo, work: Promise<T>): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => {
      log.warn({ event: 'panel.menu_counts.slow', section, deadlineMs: COUNT_DEADLINE_MS });
      resolve(null);
    }, COUNT_DEADLINE_MS);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        log.warn({ event: 'panel.menu_counts.failed', section, err });
        Sentry.captureException(err, { tags: { source: 'panel.menu-counts', section } });
        resolve(null);
      },
    );
  });
}

function through<T>(
  section: MenuBadgeSection,
  slot: Slot<T> | undefined,
  run: () => Promise<T>,
  now: number,
): Slot<T> {
  if (slot && now - slot.at < COUNT_TTL_MS) return slot;
  // `run` — под промисом: синхронный бросок `getDb()` (не задан `DATABASE_URL`)
  // иначе обходил бы `withDeadline` и ронял оболочку вместе со страницей.
  const fresh: Slot<T> = { promise: withDeadline(section, Promise.resolve().then(run)), at: now };
  // Неудачу не запоминаем: `at: 0` делает слот протухшим для следующего вызова.
  void fresh.promise.then((value) => {
    if (value === null) fresh.at = 0;
  });
  return fresh;
}

/** Заказов, ждущих оплаты, и их сумма — для стола и меню. `null` — не получили. */
export function readPendingTotals(now: number = Date.now()): Promise<PendingTotals | null> {
  memo.pending = through('pending', memo.pending, () => countPendingOrdersForPanel(getDb()), now);
  return memo.pending.promise;
}

/** Обращений без ответа. `null` — не получили. */
export function readUnansweredSupportCount(now: number = Date.now()): Promise<number | null> {
  memo.support = through('support', memo.support, () => countUnansweredSupportRequests(getDb()), now);
  return memo.support.promise;
}

/**
 * Числа для меню. Спрашиваем ТОЛЬКО при праве на раздел: роль без доступа не
 * должна получать числа по тому, что не откроет.
 */
export async function readMenuCounts(role: StaffRole): Promise<MenuCounts> {
  const [pending, support] = await Promise.all([
    canAccess(role, 'pending') ? readPendingTotals().then((r) => r?.count ?? null) : null,
    canAccess(role, 'support') ? readUnansweredSupportCount() : null,
  ]);
  return { pending, support };
}
