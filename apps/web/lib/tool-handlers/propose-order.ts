import 'server-only';

import * as Sentry from '@sentry/nextjs';

import {
  countRecentOrdersByUser,
  createDraftOrder,
  findActiveByUserId,
  getDb,
  getServiceById,
} from '@oplati/db';
import type { ProposeOrderResult } from '@oplati/agent';

import { serverEnv } from '../env.server.ts';
import { childLogger } from '../logger.ts';
import { orderFloorRub } from '../payments/gateway.ts';
import { roundUpToWholeRubles } from '../pricing.ts';
import { resolveUsdtRubRate } from '../rapira/rates.ts';

/**
 * Tool `propose_order`. Считает итоговую сумму в RUB:
 *   1. Получает текущий курс USDT→RUB (Rapira `askPrice`).
 *   2. subtotal = round(amountUsdCents/100 * rate * 100)  // копейки RUB
 *   3. commission = round(subtotal * COMMISSION_PERCENT / 100)
 *   4. подписка = ceilToRubles(subtotal + commission)  // цена без копеек, вверх
 *   5. total = подписка + ceilToRubles(надбавка за выпуск карты)
 *
 * Поддерживает два режима:
 *  - **Каталог:** `serviceId` указан → lookup в `services`, `requiresKyc` берётся
 *    из строки сервиса. Цена — со слов AI (`basePriceUsdCents × period`).
 *  - **Custom (вне каталога):** задан `customDescription` (свободный текст вида
 *    "iCloud+ 200GB, 6 мес") и опционально `serviceName` — заказ создаётся
 *    без FK на `services` (`serviceId IS NULL`, заполняется
 *    `customServiceDescription`). Цена со слов пользователя; оператор
 *    перепроверяет её перед оформлением (этот шаг — вне tool'а).
 *
 * XOR-валидация: должен быть задан ровно один из (`serviceId`,
 * `customDescription`); оба или ни один → throw.
 *
 * Создаёт draft order сразу в статусе `ready_for_payment` (план MVP — пропускаем
 * `clarifying`; AI сам ведёт уточнения внутри диалога до tool-call).
 *
 * Снимок курса (`usdt_rub_rate_kopecks`) и комиссии (`commission_percent`)
 * сохраняется в order — это важно для дисплея клиенту и для аудита.
 */

const log = childLogger('tool.propose_order');
// Фиксация цены: снапшот курса живёт 2 часа (решение владельца 2026-07-18;
// было 24 — суточный односторонний опцион на курс за счёт маржи). Протухший
// черновик хоронит cron expire-payments / гейт payments-create (H-2).
const TTL_HOURS = 2;

/**
 * Типизированные ошибки бизнес-границ. Агентский tool-loop передаёт модели
 * `message` (текст содержит инструкции для модели — это намеренно);
 * UI-endpoint `/api/orders/propose` различает их по instanceof и показывает
 * пользователю человеческий текст вместо инструкций.
 */
export class OrderAmountOutOfBoundsError extends Error {}
export class OrderCapExceededError extends Error {}
/** Итоговая сумма в RUB ниже пола заказа (`orderFloorRub`: продуктовый порог + минимум активного шлюза). */
export class OrderBelowMinimumError extends Error {}

/**
 * Серверные границы суммы заказа. Промпт-правила («цена только из web_search»)
 * — advisory: модель можно уговорить инъекцией. Реальная защита — здесь.
 * Заказы дороже MAX оформляет оператор (текст ошибки направляет модель к
 * request_human), дешевле MIN — не имеют экономического смысла.
 */
const MIN_AMOUNT_USD_CENTS = 100; // $1
const MAX_AMOUNT_USD_CENTS = 50_000; // $500

/**
 * Сервисы-«пополнения» с индивидуальной крупной ценой (Airbnb/Booking/Steam):
 * витринного потолка $500 им мало — клиент платит реальную стоимость брони/
 * пополнения. Идентифицируем СТРОГО по slug каталога, не по customDescription:
 * высокий лимит получают только распознанные каталожные сервисы, а произвольный
 * свободный текст остаётся на $500 (анти-абьюз/инъекция).
 *
 * ВНИМАНИЕ: высокий лимит ≠ гарантия выпуска карты. На карту всё равно нужен
 * VCC-баланс ≥ цена + буфер + $4 issue-fee, иначе issue-card упадёт уже ПОСЛЕ
 * приёма рублей (заказ → failed, возврат руками). Перед крупным заказом убедись,
 * что VCC пополнен под сумму.
 */
const HIGH_VALUE_SERVICE_SLUGS: ReadonlySet<string> = new Set([
  'airbnb',
  'booking',
  'steam',
  'apple-app-store',
]);
/**
 * $1200 (было $5000 до 2026-07-28). Потолок продиктован лимитом операции
 * Freekassa — 150 000 ₽: при курсе до ~95 ₽ и наценке 30% заказ на $1200
 * гарантированно влезает в него вместе с комиссией покупателя. Рублёвая
 * страховка на случай скачка курса — `FREEKASSA_MAX_AMOUNT_RUB` в
 * `payments/create`; здесь потолок в долларах, чтобы клиент упирался в него
 * ДО оформления, а не при нажатии «Оплатить».
 */
const HIGH_VALUE_MAX_AMOUNT_USD_CENTS = 120_000;

/**
 * Анти-абьюз: потолок созданных заказов на пользователя за скользящее окно.
 * Реальному клиенту хватает с запасом; спамер/инъекция не завалит `orders`
 * черновиками и не сожжёт L&P-вызовы курса.
 */
const MAX_ORDERS_PER_WINDOW = 10;
const ORDERS_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function proposeOrder(input: {
  serviceId?: string;
  customDescription?: string;
  serviceName?: string;
  amountUsdCents: number;
  paymentMethod?: 'sbp' | 'card';
  userId: string;
  conversationId: string;
}): Promise<ProposeOrderResult> {
  const {
    serviceId,
    customDescription,
    serviceName,
    userId,
    conversationId,
  } = input;

  // Модель может прислать дробные центы ($19.99 × 100 → 1998.9999…) — округляем.
  const amountUsdCents = Math.round(input.amountUsdCents);

  // Нижняя граница и валидность — не зависят от сервиса, проверяем сразу.
  // Верхний потолок — service-aware (ниже, после резолва сервиса по slug).
  if (!Number.isFinite(amountUsdCents) || amountUsdCents < MIN_AMOUNT_USD_CENTS) {
    log.warn({
      event: 'tool.propose_order.amount_below_min',
      userId,
      amountUsdCents: input.amountUsdCents,
    });
    throw new OrderAmountOutOfBoundsError(
      'propose_order: сумма ниже минимума $1 за заказ. ' +
        'Не создавай заказ и не подгоняй сумму под лимит.',
    );
  }

  const hasServiceId = typeof serviceId === 'string' && serviceId.length > 0;
  const hasCustomDescription =
    typeof customDescription === 'string' && customDescription.trim().length > 0;

  if (hasServiceId && hasCustomDescription) {
    throw new Error(
      'propose_order: задайте либо serviceId, либо customDescription, не оба',
    );
  }
  if (!hasServiceId && !hasCustomDescription) {
    throw new Error(
      'propose_order: нужен serviceId (для каталога) или customDescription (для сервисов вне каталога)',
    );
  }

  const isCustom = !hasServiceId;

  log.info({
    event: 'tool.propose_order.start',
    userId,
    serviceId: serviceId ?? null,
    customDescription: customDescription ?? null,
    serviceName: serviceName ?? null,
    amountUsdCents,
    isCustom,
  });

  const db = getDb();

  // Лимит заказов на пользователя — проверяем ДО lookup'а сервиса и запроса
  // курса в Rapira, чтобы абьюз не сжигал внешние вызовы.
  const recentOrders = await countRecentOrdersByUser(db, {
    userId,
    withinMs: ORDERS_WINDOW_MS,
  });
  if (recentOrders >= MAX_ORDERS_PER_WINDOW) {
    log.warn({ event: 'tool.propose_order.user_order_cap', userId, recentOrders });
    Sentry.captureMessage('propose_order: per-user order cap hit', {
      level: 'warning',
      tags: { source: 'tool.propose_order' },
      extra: { userId, recentOrders },
    });
    throw new OrderCapExceededError(
      'propose_order: лимит новых заказов за сутки исчерпан. Не создавай заказ ' +
        'повторно; объясни пользователю, что сегодня заказы закончились, и предложи ' +
        'продолжить с оператором (request_human).',
    );
  }

  let resolvedServiceId: string | null = null;
  let serviceRequiresKyc = false;
  let serviceSlug: string | null = null;

  if (hasServiceId) {
    const service = await getServiceById(db, serviceId);
    if (!service) {
      throw new Error(`propose_order: service ${serviceId} не найден`);
    }
    if (!service.isActive) {
      throw new Error(`propose_order: service ${serviceId} (${service.slug}) не активен`);
    }
    resolvedServiceId = service.id;
    serviceRequiresKyc = service.requiresKyc;
    serviceSlug = service.slug;
  }

  // Верхний потолок суммы — service-aware: распознанные каталожные сервисы-
  // пополнения (Airbnb/Booking/Steam) допускают крупные заказы; всё остальное,
  // включая custom-описания (serviceSlug === null), ограничено $500.
  const maxAmountUsdCents =
    serviceSlug !== null && HIGH_VALUE_SERVICE_SLUGS.has(serviceSlug)
      ? HIGH_VALUE_MAX_AMOUNT_USD_CENTS
      : MAX_AMOUNT_USD_CENTS;
  if (amountUsdCents > maxAmountUsdCents) {
    log.warn({
      event: 'tool.propose_order.amount_over_max',
      userId,
      amountUsdCents,
      maxAmountUsdCents,
      serviceSlug,
    });
    throw new OrderAmountOutOfBoundsError(
      `propose_order: сумма выше лимита $${maxAmountUsdCents / 100} за заказ. ` +
        'Через бота такой заказ оформить нельзя — не пытайся создать его повторно ' +
        'и не подгоняй сумму под лимит; предложи пользователю оператора (request_human).',
    );
  }

  const rate = await resolveUsdtRubRate();

  const commissionPercent = serverEnv.COMMISSION_PERCENT;

  // amountUsdCents / 100 = USD. USD * rate = RUB. RUB * 100 = копейки.
  // Перемножаем как (amountUsdCents * rate) и округляем до integer (копеек).
  const subtotalKopecks = Math.round(amountUsdCents * rate);
  const rawCommissionKopecks = Math.round((subtotalKopecks * commissionPercent) / 100);

  // Цена клиента — без копеек, округление ВВЕРХ (решение владельца 2026-08-05).
  // Округляем ровно ту величину, которую показывает витрина каталога
  // (subtotal + commission, см. lib/catalog/build.ts), иначе «≈ 868 ₽» в списке
  // тарифов и сумма заказа разошлись бы на рубль. Разницу относим на комиссию:
  // она наша, а разбивка «Подписка / Выпуск карты / Итого» на экране заказа
  // обязана сходиться в копейку.
  const subscriptionKopecks = roundUpToWholeRubles(subtotalKopecks + rawCommissionKopecks);
  const commissionKopecks = subscriptionKopecks - subtotalKopecks;

  // Разовая надбавка за выпуск карты: клиент оплачивает $4 issue-fee ТОЛЬКО когда
  // у него нет активной карты (issue-card выпустит новую → PaySpace спишет fee).
  // Есть активная карта → топап без fee → надбавки нет. Проверка на момент propose —
  // прогноз: активная карта может уйти в idle между заказом и оплатой (тогда fee
  // реально спишется, а мы его не взяли — редкий убыток), либо два неоплаченных
  // заказа подряд оба увидят «карты нет» (клиент переплатит один fee). Для старта
  // принимаем зазор. Fee=0 в env → фичу не трогаем (лишний запрос к БД не делаем).
  const cardIssueFeeUsdCents = serverEnv.CARD_ISSUE_FEE_USD_CENTS;
  const hasActiveCard =
    cardIssueFeeUsdCents > 0 ? (await findActiveByUserId(db, userId)) !== null : true;
  // Надбавку тоже округляем вверх до рубля — она отдельной строкой в чеке,
  // и «+ 320,48 ₽» рядом с целой ценой подписки выглядело бы недоделкой.
  // `Math.round` перед этим не декоративен: произведение центов на курс — float,
  // и хвост вида 32000.000000000004 поднял бы цену на лишний рубль.
  const cardIssueFeeKopecks =
    cardIssueFeeUsdCents > 0 && !hasActiveCard
      ? roundUpToWholeRubles(Math.round(cardIssueFeeUsdCents * rate))
      : 0;

  const totalKopecks = subscriptionKopecks + cardIssueFeeKopecks;

  // Пол платёжного терминала: заказ дешевле минимума всё равно не оплатить
  // (`/api/payments/create` вернёт `below_min_amount`). Ловим ЗДЕСЬ, до создания
  // draft-заказа, чтобы не плодить неоплатимые черновики и дать понятный ответ.
  //
  // Минимум — `orderFloorRub()`, а не зашитый на L&P (аудит 2026-08-10): гейт в
  // `payments/create` считает по АКТИВНОМУ шлюзу, и при разъезде env заказ
  // создавался, а оплатить его было нельзя — да ещё и текст называл клиенту
  // чужую цифру. Тот же пол держит витрина (`catalog/load.ts`), иначе клиент
  // выбирал бы тариф, который заказом стать не может.
  const minAmountRub = orderFloorRub();
  const minOrderKopecks = minAmountRub * 100;
  if (totalKopecks < minOrderKopecks) {
    log.warn({
      event: 'tool.propose_order.below_minimum',
      userId,
      totalKopecks,
      minOrderKopecks,
    });
    throw new OrderBelowMinimumError(
      `propose_order: сумма заказа ${Math.round(totalKopecks / 100)} ₽ ниже минимума ` +
        `${minAmountRub} ₽ (ограничение платёжного терминала). ` +
        'Не создавай заказ и не подгоняй сумму под лимит; предложи пользователю тариф ' +
        'подороже или оплату нескольких подписок одним заказом (либо оператора, request_human).',
    );
  }

  // Сохраняем курс как `rate * 10000` (фиксированная точка с 4 знаками) в integer —
  // чтобы 95.2345 RUB/USDT хранился как 952345. Это совместимо с `usdt_rub_rate_kopecks integer`.
  const usdtRubRateKopecks = Math.round(rate * 10_000);

  const expiresAt = new Date(Date.now() + TTL_HOURS * 60 * 60 * 1000);

  const order = await createDraftOrder(
    db,
    {
      userId,
      conversationId,
      serviceId: resolvedServiceId,
      customServiceDescription: isCustom ? customDescription : null,
      status: 'ready_for_payment',
      amountRub: totalKopecks,
      originalAmount: amountUsdCents,
      originalCurrency: 'USD',
      usdtRubRateKopecks,
      rateFixedAt: new Date(),
      expiresAt,
      commissionPercent,
      cardIssueFeeKopecks,
      requiresKyc: serviceRequiresKyc,
      parameters: isCustom
        ? {
            extra: {
              source: 'custom',
              ...(serviceName ? { serviceName } : {}),
            },
          }
        : null,
    },
    log,
  );

  if (isCustom) {
    log.info({
      event: 'tool.propose_order.custom',
      orderId: order.id,
      shortId: order.shortId,
      customDescription,
      serviceName: serviceName ?? null,
      amountUsdCents,
      totalRubKopecks: totalKopecks,
    });
  }

  log.info({
    event: 'tool.propose_order.ok',
    orderId: order.id,
    shortId: order.shortId,
    isCustom,
    amountUsdCents,
    rate,
    subtotalKopecks,
    commissionKopecks,
    cardIssueFeeKopecks,
    totalKopecks,
  });

  return {
    orderId: order.id,
    shortId: order.shortId,
    amountRubKopecks: subtotalKopecks,
    commissionKopecks,
    totalRubKopecks: totalKopecks,
    rateUsdRubKopecks: usdtRubRateKopecks,
    originalAmountUsdCents: amountUsdCents,
    expiresAt: expiresAt.toISOString(),
    isCustom,
  };
}
