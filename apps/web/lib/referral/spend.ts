import 'server-only';

import * as Sentry from '@sentry/nextjs';

import {
  appendOrderEvent,
  BONUS_RELEASED_EVENT,
  findPromoRedemptionByOrderId,
  findRedemptionByOrderId,
  findSelfReferralSignals,
  getDb,
  getPartnerProfile,
  getReferralBalanceUsdCents,
  getUserTelegramId,
  releaseUnusedBonusReservation,
  reserveBonusForOrder,
  type OrderRow,
} from '@oplati/db';

import { serverEnv } from '../env.server.ts';
import { DedupWindow } from '../alerts/dedup-window.ts';
import { notifyStaff } from '../alerts/notify-staff.ts';
import { childLogger } from '../logger.ts';
import { minAmountRubFor, primaryPaymentGateway } from '../payments/gateway.ts';
import {
  bonusSpendCapKopecks,
  planBonusSpend,
  referralSpendMinUsdCents,
  type BonusSpendPlan,
} from './spend-math.ts';

/**
 * Гейты доступа и занятие баллов под заказ (трек referral-balance-spend, §9).
 *
 * Здесь живут ТОЛЬКО решения «кому и сколько можно», без арифметики (она в
 * `spend-math.ts`) и без SQL (он в `@oplati/db`). Модуль зовут две точки —
 * снапшот кабинета (что показать на экране заказа) и `payments/create` (что
 * реально списать), — и обе обязаны видеть одинаковый ответ: экран, который
 * предлагает скидку, а кнопка её не даёт, хуже отсутствия скидки.
 */

const log = childLogger('referral-spend');

/** Минимум счёта у АКТИВНОГО шлюза в копейках — ниже него счёт не выставится. */
function minInvoiceKopecks(): number {
  return minAmountRubFor(primaryPaymentGateway()) * 100;
}

/**
 * Разбор `REFERRAL_SPEND_ALLOWLIST`. Пусто = фича открыта всем; список
 * telegram_id через запятую = только им (на время смоука — id владельца).
 */
function allowlist(): readonly string[] {
  return serverEnv.REFERRAL_SPEND_ALLOWLIST.split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Включена ли фича вообще (оба флага). Дальше решает конкретный клиент. */
export function isBonusSpendEnabled(): boolean {
  return serverEnv.REFERRAL_ENABLED && serverEnv.REFERRAL_SPEND_ENABLED;
}

/**
 * Доступно ли списание баллов ЭТОМУ клиенту — без привязки к заказу.
 *
 * Нужен кабинету партнёра: он рассказывает про переключатель, а тот живёт на
 * экране заказа. Обещать кнопку тому, у кого её нет (флаг выключен, клиент вне
 * allowlist, партнёр заблокирован), — способ получить обращение в поддержку.
 *
 * Never-throw: подпись под витриной, а не под деньгами.
 */
export async function isBonusSpendAvailableForUser(userId: string): Promise<boolean> {
  if (!isBonusSpendEnabled()) return false;
  try {
    const db = getDb();
    const allowed = allowlist();
    if (allowed.length > 0) {
      const telegramId = await getUserTelegramId(db, userId);
      if (telegramId === null || !allowed.includes(telegramId)) return false;
    }
    const profile = await getPartnerProfile(db, userId);
    return !profile?.suspended;
  } catch (err) {
    log.error({ event: 'referral.spend.availability_failed', userId, err });
    Sentry.captureException(err, { tags: { source: 'referral.spend', step: 'availability' } });
    return false;
  }
}

export type BonusSpendState = {
  /** Живой баланс баллов, USD-центы. */
  balanceUsdCents: number;
  /** Потолок скидки по этому заказу (комиссия, усечённая минимумом шлюза). */
  capKopecks: number;
  /** Что предлагаем списать; `null` — предлагать нечего (например, баланс < $1). */
  offer: BonusSpendPlan | null;
  /** Минимум одного списания в центах — экран объясняет им «баллы копятся». */
  minSpendUsdCents: number;
};

/**
 * Состояние баллов для экрана заказа. `null` — блока нет вовсе:
 * фича выключена, клиент вне allowlist, партнёр заблокирован антифродом или
 * баланс нулевой.
 *
 * Строка показывается ВСЕГДА, когда баланс > 0 (решение Q16) — даже когда
 * списывать ещё нечего: партнёру важно видеть, что программа работает.
 * Требования «иметь свою покупку» нет: баланс возникает только от ЧУЖОЙ оплаты,
 * то есть деньги в систему уже пришли.
 *
 * ⚠️ БРОСАЕТ при сбое чтения. Never-throw-обёртка — `loadBonusSpendStateSafe`,
 * и она годится только витрине: на пути ОПЛАТЫ проглоченная ошибка означала бы
 * молча выставленный полный счёт клиенту, который нажал «оплатить со скидкой»
 * (находка ревью). Там сбой обязан стать честным отказом.
 */
export async function loadBonusSpendState(
  order: OrderRow,
  /**
   * Скидка, уже данная промокодом по этому заказу (трек promo-codes).
   * Порядок «промокод первый, баллы вторые»: потолок баллов считается от
   * ОСТАВШЕЙСЯ маржи и от уже уменьшенного счёта.
   */
  promoDiscountKopecks = 0,
): Promise<BonusSpendState | null> {
  if (!isBonusSpendEnabled()) return null;
  const db = getDb();
  const allowed = allowlist();
  if (allowed.length > 0) {
    const telegramId = await getUserTelegramId(db, order.userId);
    if (telegramId === null || !allowed.includes(telegramId)) return null;
  }
  const profile = await getPartnerProfile(db, order.userId);
  if (profile?.suspended) return null;

  const balanceUsdCents = await getReferralBalanceUsdCents(db, order.userId);
  if (balanceUsdCents <= 0) return null;

  const minInvoice = minInvoiceKopecks();
  return {
    balanceUsdCents,
    capKopecks: bonusSpendCapKopecks({
      order,
      minInvoiceKopecks: minInvoice,
      promoDiscountKopecks,
    }),
    offer: planBonusSpend({
      order,
      balanceUsdCents,
      minInvoiceKopecks: minInvoice,
      promoDiscountKopecks,
    }),
    minSpendUsdCents: referralSpendMinUsdCents(),
  };
}

/**
 * То же для ВИТРИНЫ: сбой гасит блок баллов, но не ломает экран заказа —
 * человеку важнее увидеть свой заказ, чем предложение скидки.
 */
export async function loadBonusSpendStateSafe(
  order: OrderRow,
  promoDiscountKopecks = 0,
): Promise<BonusSpendState | null> {
  try {
    return await loadBonusSpendState(order, promoDiscountKopecks);
  } catch (err) {
    log.error({ event: 'referral.spend.state_failed', orderId: order.id, err });
    Sentry.captureException(err, { tags: { source: 'referral.spend', step: 'state' } });
    return null;
  }
}

export type BonusClaimResult =
  /**
   * Скидка применена — счёт уменьшается на `plan.discountKopecks`.
   *
   * `owned` отвечает на вопрос «наше ли это занятие». `false` — строку заняла
   * ДРУГАЯ попытка того же заказа (двойной тап, вторая вкладка): скидку берём
   * из неё, но снимать её в своём `catch` нельзя — иначе проигравший освободил
   * бы баллы под уже выставленным счётом победителя, и клиент заплатил бы
   * меньше, не потратив ни одного балла.
   */
  | { kind: 'claimed'; plan: BonusSpendPlan; owned: boolean }
  /** Фича клиента не касается — счёт выставляем полный, молча. */
  | { kind: 'skipped' }
  /** Клиент просил скидку, а дать её нечем — отказ, а НЕ полный счёт молча. */
  | { kind: 'unavailable'; balanceUsdCents: number };

/**
 * Занять баллы под заказ перед выставлением счёта.
 *
 * Три исхода, и разница между вторым и третьим принципиальная:
 *
 *  - `skipped` — фича выключена или клиент вне allowlist. Тогда `useBonus` от
 *    клиента ИГНОРИРУЕТСЯ: он и не мог видеть переключателя, а счёт на полную
 *    сумму — ровно то, чего он ждёт.
 *  - `unavailable` — фича клиента касается, он нажал «оплатить со скидкой», а
 *    занять нечего (параллельная заявка на вывод успела раньше, баланс упал
 *    ниже минимума). Молча выставленный полный счёт здесь был бы обманом,
 *    поэтому отказ с актуальным балансом и просьбой обновить экран.
 *
 * ⚠️ Занятие идёт под тем же локом, что заявка на вывод (`hashtext(userId)`), и
 * баланс перепроверяется ВНУТРИ лока — расчёт снаружи мог устареть.
 */
export async function claimBonusForOrder(
  order: OrderRow,
  /** Скидка промокода по этому заказу — потолок баллов считается от остатка. */
  promoDiscountKopecks = 0,
): Promise<BonusClaimResult> {
  let state: BonusSpendState | null;
  try {
    state = await loadBonusSpendState(order, promoDiscountKopecks);
  } catch (err) {
    // ⚠️ Сбой чтения — это `unavailable`, а НЕ `skipped`. Проглоченная ошибка
    // здесь означала бы счёт на полную сумму клиенту, который нажал «оплатить
    // со списанием баллов»: то самое молчаливое враньё, ради запрета которого
    // и заведён отдельный исход (находка ревью).
    log.error({ event: 'referral.spend.claim_state_failed', orderId: order.id, err });
    Sentry.captureException(err, { tags: { source: 'referral.spend', step: 'claim_state' } });
    return { kind: 'unavailable', balanceUsdCents: 0 };
  }
  if (state === null) return { kind: 'skipped' };
  if (state.offer === null) {
    log.info({
      event: 'referral.spend.unavailable',
      orderId: order.id,
      userId: order.userId,
      balanceUsdCents: state.balanceUsdCents,
      reason: 'no_offer',
    });
    return { kind: 'unavailable', balanceUsdCents: state.balanceUsdCents };
  }

  const reserved = await reserveBonusForOrder(getDb(), {
    orderId: order.id,
    userId: order.userId,
    spendUsdCents: state.offer.spendUsdCents,
    discountKopecks: state.offer.discountKopecks,
    rateKopecks: order.usdtRubRateKopecks ?? 0,
  });
  if (!reserved.ok) {
    if (reserved.reason === 'already_reserved') {
      // Не отказ: под этот заказ уже занято, просто не нами. Отдать здесь
      // `unavailable` значило бы ответить «баланс изменился» на обычный
      // двойной тап — при том что счёт со скидкой как раз выставляется.
      log.info({
        event: 'referral.spend.already_reserved',
        orderId: order.id,
        userId: order.userId,
        spendUsdCents: reserved.existing.amountUsdCents,
      });
      return {
        kind: 'claimed',
        owned: false,
        plan: {
          discountKopecks: reserved.existing.discountKopecks,
          spendUsdCents: reserved.existing.amountUsdCents,
        },
      };
    }
    log.warn({
      event: 'referral.spend.unavailable',
      orderId: order.id,
      userId: order.userId,
      balanceUsdCents: reserved.balanceUsdCents,
      reason: reserved.reason,
    });
    return { kind: 'unavailable', balanceUsdCents: reserved.balanceUsdCents };
  }

  log.info({
    event: 'referral.spend.reserved',
    orderId: order.id,
    userId: order.userId,
    spendUsdCents: state.offer.spendUsdCents,
    discountKopecks: state.offer.discountKopecks,
  });
  // Сигнал самореферала — ПОСЛЕ занятия и вне критического пути: он ничего не
  // решает и ничего не блокирует, а задержать выставление счёта им нельзя.
  await reportSelfReferralIfAny(order.userId);
  return { kind: 'claimed', owned: true, plan: state.offer };
}

/** Окно молчания сигнала самореферала: сутки на партнёра. */
const selfReferralDedup = new DedupWindow(24 * 60 * 60 * 1000);

/** Только для тестов. */
export function resetSelfReferralDedupForTests(): void {
  selfReferralDedup.resetForTests();
}

/**
 * Совпали ли контакты партнёра с контактами его же реферала (E3-lite, Q6).
 *
 * Списание баллов впервые делает баланс настоящими деньгами и вместе с этим —
 * выгодным мультиаккаунтный самореферал: второй аккаунт даёт кэшбэк на своих
 * покупках. Маржа это переживает, но человек должен знать.
 *
 * НЕ блокировка: совпадение IP — это ещё и семья, и наш собственный VPN, и один
 * мобильный оператор за CGNAT. Решение принимает человек через `suspended`.
 * Never-throw: сигнал не может помешать оплате.
 */
async function reportSelfReferralIfAny(userId: string): Promise<void> {
  try {
    if (!selfReferralDedup.isFree(userId)) return;
    const matches = await findSelfReferralSignals(getDb(), userId);
    if (matches.length === 0) return;
    const signals = [...new Set(matches.map((m) => m.signal))].join(', ');
    log.warn({ event: 'referral.spend.self_referral_signal', userId, signals });
    await notifyStaff(
      'Партнёр тратит баллы, а его контакты совпадают с контактами приглашённого им клиента. ' +
        'Это может быть один человек с двумя аккаунтами, а может быть семья или общий адрес. ' +
        'Блокировок не ставим автоматически — решение за человеком.',
      {
        capability: 'partners',
        title: 'Похоже на самореферал',
        facts: [
          { label: 'Совпало по', value: signals },
          { label: 'Приглашённых с совпадением', value: String(matches.length) },
        ],
        action: { text: 'посмотреть партнёра', path: '/admin/partners' },
        dedupKey: `self-referral:${userId}`,
        dedupWindowMs: 24 * 60 * 60 * 1000,
      },
    );
    selfReferralDedup.record(userId);
  } catch (err) {
    log.error({ event: 'referral.spend.self_referral_check_failed', userId, err });
    Sentry.captureException(err, { tags: { source: 'referral.spend', step: 'self_referral' } });
  }
}

/**
 * Снять занятие немедленно — счёт создать не удалось.
 *
 * Never-throw по образцу `releaseOrderFundingClaim`: этот путь проходят таймауты
 * шлюза, после которых заказ живёт дальше и клиент вернётся. Но и не молча:
 * несостоявшееся освобождение держит баллы клиента занятыми до протухания
 * заказа, и знать об этом по строке в логах никто не будет.
 *
 * ⚠️ Занятие под УЖЕ созданным счётом не снимается (условие живёт в
 * `releaseUnusedBonusReservation`): параллельная попытка того же заказа могла
 * успеть выставить счёт со скидкой, и освобождение отдало бы клиенту скидку
 * бесплатно — списывать на вебхуке было бы уже нечего.
 */
export async function releaseBonusClaim(orderId: string): Promise<void> {
  try {
    const db = getDb();
    const { applied, redemption } = await releaseUnusedBonusReservation(db, orderId);
    if (!applied || !redemption) return;
    log.info({
      event: 'referral.spend.released',
      orderId,
      userId: redemption.userId,
      spendUsdCents: redemption.amountUsdCents,
    });
    // Событие пишем только на ЯВНОМ освобождении: автовозврат по правилу
    // «денег не приходило» событий не пишет — события про НАШИ действия, а там
    // мы ничего не делаем.
    await appendOrderEvent(db, {
      orderId,
      eventType: BONUS_RELEASED_EVENT,
      actorType: 'system',
      payload: {
        spendUsdCents: redemption.amountUsdCents,
        discountKopecks: redemption.discountKopecks,
        reason: 'invoice_not_created',
      },
    });
  } catch (err) {
    log.error({ event: 'referral.spend.release_failed', orderId, err });
    Sentry.captureException(err, { tags: { source: 'referral.spend', step: 'release' } });
  }
}

/**
 * Сколько по заказу РЕАЛЬНО запросили у шлюза: полная цена минус живое
 * списание. `discountKopecks === 0` — списания не было.
 *
 * Нужен текстам, которые называют клиенту сумму рядом со ссылкой на оплату:
 * `orders.amount_rub` остаётся ПОЛНОЙ ценой, и назвать её значило бы попросить
 * денег больше, чем просит платёжная страница.
 *
 * Never-throw: сбой чтения возвращает полную сумму без строки про баллы —
 * текст остаётся верным для подавляющего большинства заказов, а сообщение
 * уходит. Умолчание безопасно и в другую сторону: названная сумма не может
 * оказаться МЕНЬШЕ запрошенной у шлюза.
 */
export async function invoicedAmountForOrder(order: {
  id: string;
  amountRub: number | null;
}): Promise<{ amountKopecks: number | null; discountKopecks: number }> {
  const full = order.amountRub;
  try {
    const db = getDb();
    const redemption = await findRedemptionByOrderId(db, order.id);
    const bonusKopecks =
      redemption && redemption.status !== 'released' ? redemption.discountKopecks : 0;
    // ⚠️ Скидка по промокоду входит в ту же сумму (трек promo-codes): назвать
    // клиенту цену без неё значило бы попросить больше, чем просит платёжная
    // страница. Обе скидки складываются — счёт уменьшен на обе.
    const promoRow = await findPromoRedemptionByOrderId(db, order.id);
    const promoKopecks =
      promoRow && promoRow.status !== 'released' ? promoRow.discountKopecks : 0;
    const discountKopecks = bonusKopecks + promoKopecks;
    return {
      amountKopecks: full === null ? null : full - discountKopecks,
      discountKopecks,
    };
  } catch (err) {
    log.error({ event: 'referral.spend.invoiced_amount_failed', orderId: order.id, err });
    Sentry.captureException(err, { tags: { source: 'referral.spend', step: 'invoiced_amount' } });
    return { amountKopecks: full, discountKopecks: 0 };
  }
}
