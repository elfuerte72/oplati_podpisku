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
 *     сбой держал бы стол на «не получили» весь срок памятки; а действие,
 *     меняющее число (ответ клиенту), сбрасывает памятку явно —
 *     `invalidateMenuCounts`;
 *   - никогда не бросает: отказ базы — это `null` («не получили»), страница
 *     остаётся живой.
 */

const log = childLogger('panel.menu-counts');

const COUNT_TTL_MS = 5_000;
const COUNT_DEADLINE_MS = 2_000;

export type PendingTotals = { count: number; sumKopecks: number };

/**
 * Слот памятки держит САМ запрос (без дедлайна): дедлайн — на каждый вызов,
 * а не на запрос. Иначе медленная база порождала бы по новому запросу на
 * каждый рендер, а поздний удачный ответ выбрасывался бы; здесь все рендеры
 * ждут один и тот же запрос, каждый — не дольше своего бюджета.
 */
type Slot<T> = { work: Promise<T | null>; at: number };

const memo: { pending?: Slot<PendingTotals>; support?: Slot<number> } = {};

/**
 * Сбросить памятку после действия, которое меняет число: ответ клиенту в
 * поддержке гасит «без ответа», и следующий `router.refresh()` обязан показать
 * свежий счётчик, а не переждать срок памятки.
 */
export function invalidateMenuCounts(section?: MenuBadgeSection): void {
  if (section === undefined || section === 'pending') delete memo.pending;
  if (section === undefined || section === 'support') delete memo.support;
}

/** Дедлайн без отмены: запрос дорабатывает в фоне и кормит памятку. */
function withDeadline<T>(section: MenuBadgeSection, work: Promise<T | null>): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => {
      log.warn({ event: 'panel.menu_counts.slow', section, deadlineMs: COUNT_DEADLINE_MS });
      resolve(null);
    }, COUNT_DEADLINE_MS);
    void work.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

/**
 * Памяткой владеет ТОЛЬКО эта функция: она кладёт слот и она же убирает его,
 * если запрос отказал, — неудача буквально не хранится.
 */
function through<T>(
  section: MenuBadgeSection,
  get: () => Slot<T> | undefined,
  set: (slot: Slot<T> | undefined) => void,
  run: () => Promise<T>,
  now: number,
): Promise<T | null> {
  let slot = get();
  if (!slot || now - slot.at >= COUNT_TTL_MS) {
    // `run` — под промисом: синхронный бросок `getDb()` (не задан `DATABASE_URL`)
    // иначе ронял бы оболочку вместе со страницей. Таймаут — только лог (база
    // медленная), а НЕОЖИДАННЫЙ отказ уходит в Sentry: «зелёная панель,
    // мёртвый счётчик» — та форма, в которой прошёл инцидент `freekassa_nonce`.
    const work: Promise<T | null> = Promise.resolve()
      .then(run)
      .catch((err: unknown) => {
        log.warn({ event: 'panel.menu_counts.failed', section, err });
        Sentry.captureException(err, { tags: { source: 'panel.menu-counts', section } });
        return null;
      });
    const fresh: Slot<T> = { work, at: now };
    set(fresh);
    void work.then((value) => {
      if (value === null && get() === fresh) set(undefined);
    });
    slot = fresh;
  }
  return withDeadline(section, slot.work);
}

/** Заказов, ждущих оплаты, и их сумма — для стола и меню. `null` — не получили. */
export function readPendingTotals(now: number = Date.now()): Promise<PendingTotals | null> {
  return through(
    'pending',
    () => memo.pending,
    (slot) => {
      memo.pending = slot;
    },
    () => countPendingOrdersForPanel(getDb()),
    now,
  );
}

/** Обращений без ответа. `null` — не получили. */
export function readUnansweredSupportCount(now: number = Date.now()): Promise<number | null> {
  return through(
    'support',
    () => memo.support,
    (slot) => {
      memo.support = slot;
    },
    () => countUnansweredSupportRequests(getDb()),
    now,
  );
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
