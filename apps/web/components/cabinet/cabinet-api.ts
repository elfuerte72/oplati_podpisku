'use client';

import { z } from 'zod';
import { billingAddress as billingAddressSchema, servicePaymentInstructions } from '@oplati/types';

import type { PaymentIssueType, PaymentProblemType } from '@/lib/cabinet/payment-issues';
import { fetchWithTimeout } from '@/lib/http';

import { errorTextFor } from './error-text';

/**
 * Клиент `/api/cabinet`: на каждый запрос шлём `initData` (подпись Telegram) +
 * action. Ответы парсим Zod-схемами (как ChatClient), чтобы не доверять форме
 * данных вслепую. Схемы зеркалят view-типы из `lib/cabinet/types.ts`.
 */

const orderSummarySchema = z.object({
  orderId: z.string(),
  shortId: z.string(),
  status: z.string(),
  statusLabel: z.string(),
  service: z.string(),
  amountKopecks: z.number().nullable(),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
  payable: z.boolean(),
  /**
   * Списание реферальных баллов по заказу; null — списания нет.
   *
   * ⚠️ `amountKopecks` остаётся ПОЛНОЙ ценой; к оплате идёт разница. Поле
   * необязательное: старый WebView-бандл о нём не знает, а новый обязан
   * пережить снапшот деплоя, где фичи ещё нет.
   */
  bonus: z
    .object({
      discountKopecks: z.number().int().positive(),
      spendUsdCents: z.number().int().positive(),
      status: z.string(),
    })
    .nullable()
    .optional(),
  /**
   * Скидка по промокоду на этом заказе; null — промокода не было.
   *
   * Сам код сервер не отдаёт намеренно — экран называет скидку, а не акцию.
   * `.optional()` по той же причине, что у `bonus`: бандл обязан пережить
   * снапшот деплоя, где фичи ещё нет.
   */
  promo: z
    .object({
      discountKopecks: z.number().int().positive(),
      status: z.string(),
    })
    .nullable()
    .optional(),
  /**
   * Карта, выданная по заказу, и отметка «Подписка оформлена» — по ним вкладка
   * «Карта» собирает свои заказы и шаг 3 (трек miniapp-tabs, тикет 06).
   * `.optional()` по той же причине, что у `bonus`: снапшот деплоя без полей
   * просто не покажет «Остался один шаг», а не уронит кабинет.
   */
  cardId: z.string().nullable().optional(),
  subscriptionActivated: z.boolean().optional(),
});

/** Правила оплаты сервиса (VPN/валюта/billing/ссылка) — как в каталоге. */
const instructionsSchema = servicePaymentInstructions.nullable();

const cardViewSchema = z.object({
  id: z.string(),
  panMasked: z.string(),
  status: z.string(),
  statusLabel: z.string(),
  balanceUsdCents: z.number(),
  createdAt: z.string(),
  validUntil: z.string(),
  purpose: z.string().nullable(),
  purposeOrderId: z.string().nullable(),
  instructions: instructionsSchema,
});

const cardDetailsResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    number: z.string(),
    exp: z.string(),
    cvc: z.string(),
    /**
     * Адрес плательщика, закреплённый за клиентом (тикет 07). Необязательный:
     * без него лист реквизитов показывает только номер, срок и CVC.
     */
    billingAddress: billingAddressSchema.optional(),
  }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

const paymentViewSchema = z.object({
  amountKopecks: z.number(),
  status: z.string(),
  statusLabel: z.string(),
  invoiceNumber: z.string().nullable(),
  createdAt: z.string(),
});

const eventViewSchema = z.object({ label: z.string(), at: z.string(), type: z.string() });

const profileSchema = z.object({
  displayName: z.string().nullable(),
  phone: z.string().nullable(),
  // Откуда номер (антифрод-трек): 'telegram' | 'manual' | null.
  phoneSource: z.string().nullable(),
  email: z.string().nullable(),
  telegramLinked: z.boolean(),
  memberSince: z.string(),
  ordersCount: z.number(),
  totalSpentKopecks: z.number(),
  /** Баланс реферальных баллов, USD-центы; null — фича клиента не касается. */
  bonusBalanceUsdCents: z.number().int().nullable().optional(),
});

const snapshotSchema = z.object({
  ok: z.literal(true),
  profile: profileSchema,
  orders: z.array(orderSummarySchema),
  cards: z.array(cardViewSchema),
  // Порог «телефон обязателен» в целых рублях (тикет 05); null — выключено.
  phoneRequiredFromRub: z.number().nullable(),
  /** Реф-ссылка для главного меню (кнопка «Скопировать»); null — программа выключена. */
  referralLink: z.string().nullable(),
});

const orderDetailSchema = orderSummarySchema.extend({
  originalAmount: z.number().nullable(),
  originalCurrency: z.string().nullable(),
  commissionPercent: z.number().nullable(),
  // Курс × 10000 — строго положительный integer (пишется только как
  // round(rate × 10000) в propose_order) либо null у заказов без курса.
  usdtRubRateKopecks: z.number().int().positive().nullable(),
  instructions: instructionsSchema,
  cardIssueFeeKopecks: z.number().nullable(),
  // Надбавка платёжной системы на плательщика, % (0 — её нет). Поле обязательное:
  // снапшот собирает сервер того же деплоя, что и этот бандл. Старый WebView-бандл
  // о поле просто не знает и отбросит его — рассинхрон в эту сторону безопасен.
  buyerFeePercent: z.number().min(0),
  paidAt: z.string().nullable(),
  fulfilledAt: z.string().nullable(),
  events: z.array(eventViewSchema),
  payments: z.array(paymentViewSchema),
  card: cardViewSchema.nullable(),
  /**
   * Что предложить списать баллами на этом экране; null — блока нет.
   * `.optional()` по той же причине, что у `bonus`: бандл переживает снапшот
   * деплоя без фичи.
   */
  bonusOffer: z
    .object({
      balanceUsdCents: z.number().int(),
      balanceKopecks: z.number().int(),
      capKopecks: z.number().int(),
      offer: z
        .object({
          discountKopecks: z.number().int().positive(),
          spendUsdCents: z.number().int().positive(),
        })
        .nullable(),
      minSpendUsdCents: z.number().int().positive(),
    })
    .nullable()
    .optional(),
  /** Показывать ли поле ввода промокода. Отсутствует у старого бандла — значит «нет». */
  promoInputEnabled: z.boolean().optional(),
});

const orderDetailResponseSchema = z.object({ ok: z.literal(true), order: orderDetailSchema });

/**
 * Ответ на проверку промокода. Несёт ПЕРЕСЧИТАННОЕ предложение по баллам:
 * потолок баллов зависит от промокода («промокод первый, баллы вторые»), и
 * показать одну скидку без второй значило бы назвать клиенту сумму, которой в
 * счёте не будет.
 */
const promoCheckResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    discountKopecks: z.number().int().positive(),
    capped: z.boolean(),
    bonusOffer: orderDetailSchema.shape.bonusOffer,
  }),
  z.object({ ok: z.literal(false), error: z.string(), message: z.string().optional() }),
]);

export type PromoCheckResult = z.infer<typeof promoCheckResultSchema>;

const payResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    paymentUrl: z.string(),
    qrPayload: z.string().nullable(),
    expiresAt: z.string().nullable(),
  }),
  z.object({ ok: z.literal(false), error: z.string(), message: z.string().optional() }),
]);

/** Результат создания заказа из каталога Mini App (`doPropose`). */
const orderCreationResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    orderId: z.string(),
    shortId: z.string(),
    service: z.string(),
    totalKopecks: z.number(),
    expiresAt: z.string(),
  }),
  z.object({ ok: z.literal(false), error: z.string(), message: z.string().optional() }),
]);

export type OrderSummary = z.infer<typeof orderSummarySchema>;
export type CardView = z.infer<typeof cardViewSchema>;
export type CardDetailsResult = z.infer<typeof cardDetailsResultSchema>;
export type PaymentView = z.infer<typeof paymentViewSchema>;
export type OrderEventView = z.infer<typeof eventViewSchema>;
export type CabinetProfile = z.infer<typeof profileSchema>;
export type Snapshot = z.infer<typeof snapshotSchema>;
export type OrderDetail = z.infer<typeof orderDetailSchema>;
export type PayResult = Extract<z.infer<typeof payResultSchema>, { ok: true }> | CabinetFailure;
export type OrderCreationResult =
  | Extract<z.infer<typeof orderCreationResultSchema>, { ok: true }>
  | CabinetFailure;

export type ApiError = { ok: false; status: number; error: string };
export type ApiOk<T> = { ok: true; data: T };
export type ApiResult<T> = ApiOk<T> | ApiError;

const GENERIC_ERROR = 'network_error';

/** Общая форма отказа действия: код для логики + всегда готовый текст для UI. */
export type CabinetFailure = { ok: false; error: string; message: string };
const NETWORK_ERROR_TEXT = 'Сеть недоступна. Попробуй ещё раз.';

/**
 * Достраивает `message` там, где сервер прислал только код.
 *
 * Роут отвечает `{ok:false, error}` без текста на 401 (протухшая/битая подпись),
 * 429 и 503 — а схемы действий раньше требовали `message` и на таких ответах
 * просто не парсились, из-за чего кнопка «Оплатить» показывала «Сеть
 * недоступна» при живой сети (ревью 2026-08-11). Тексты берём из общей карты
 * `errorTextFor`, чтобы они не разъезжались с экранами загрузки.
 */
function withMessage<T extends { ok: true }>(
  result: T | { ok: false; error: string; message?: string },
): T | CabinetFailure {
  if (result.ok) return result;
  return { ok: false, error: result.error, message: result.message ?? errorTextFor(result.error) };
}


/**
 * Таймаут запросов кабинета. Щедрый, потому что `pay` под капотом создаёт счёт
 * L&P через self-call (route maxDuration 60 с) — как 65 с у confirm в веб-чате.
 */
const CABINET_TIMEOUT_MS = 65_000;

async function callCabinet(
  body: Record<string, unknown>,
  timeoutMs: number = CABINET_TIMEOUT_MS,
): Promise<{ status: number; json: unknown } | null> {
  try {
    const res = await fetchWithTimeout(
      '/api/cabinet',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      timeoutMs,
    );
    const json: unknown = await res.json().catch(() => null);
    return { status: res.status, json };
  } catch {
    return null;
  }
}

function parseOrError<T>(
  resp: { status: number; json: unknown } | null,
  schema: z.ZodType<T>,
): ApiResult<T> {
  if (!resp) return { ok: false, status: 0, error: GENERIC_ERROR };
  const parsed = schema.safeParse(resp.json);
  if (parsed.success) return { ok: true, data: parsed.data };
  const err =
    resp.json && typeof resp.json === 'object' && 'error' in resp.json
      ? String((resp.json as { error: unknown }).error)
      : GENERIC_ERROR;
  return { ok: false, status: resp.status, error: err };
}

export async function fetchSnapshot(initData: string): Promise<ApiResult<Snapshot>> {
  const resp = await callCabinet({ action: 'snapshot', initData });
  return parseOrError(resp, snapshotSchema);
}

/**
 * Поводок для «Написать в поддержку»: клиент ждёт, пока закроется кабинет, и
 * минута ожидания щедрого общего таймаута тут означала бы зависшую кнопку.
 */
const SUPPORT_OPEN_TIMEOUT_MS = 8_000;

/**
 * Попросить бота прислать в чат кнопку «Поддержка» (перед закрытием кабинета).
 * `true` — сообщение доставлено.
 */
export async function doOpenSupport(initData: string): Promise<boolean> {
  const resp = await callCabinet({ action: 'support-open', initData }, SUPPORT_OPEN_TIMEOUT_MS);
  return resp !== null && resp.status === 200;
}

const cardLiveResponseSchema = z.object({
  ok: z.literal(true),
  card: z
    .object({ cardId: z.string(), balanceUsdCents: z.number().int(), validUntil: z.string() })
    .nullable(),
});

export type CardLive = NonNullable<z.infer<typeof cardLiveResponseSchema>['card']>;

/**
 * Живой баланс и срок основной карты (PaySpace) — отдельно от снапшота: тот
 * отвечает из БД сразу, а этот запрос идёт следом в фоне (~1,2 с у провайдера).
 * `data: null` — карты нет.
 */
export async function fetchCardLive(initData: string): Promise<ApiResult<CardLive | null>> {
  const resp = await callCabinet({ action: 'card-live', initData });
  const result = parseOrError(resp, cardLiveResponseSchema);
  return result.ok ? { ok: true, data: result.data.card } : result;
}

export async function fetchOrderDetail(
  initData: string,
  orderId: string,
): Promise<ApiResult<OrderDetail>> {
  const resp = await callCabinet({ action: 'order', initData, orderId });
  const result = parseOrError(resp, orderDetailResponseSchema);
  return result.ok ? { ok: true, data: result.data.order } : result;
}

/**
 * Разовый показ реквизитов карты (номер/срок/CVC). Сервер тянет их живым
 * запросом из PaySpace и НЕ хранит. Ответ не кэшируется (no-store на роуте).
 */
export async function fetchCardDetails(initData: string, cardId: string): Promise<CardDetailsResult> {
  const resp = await callCabinet({ action: 'card-details', initData, cardId });
  const parsed = resp ? cardDetailsResultSchema.safeParse(resp.json) : null;
  if (parsed?.success) return parsed.data;
  return { ok: false, error: 'network_error' };
}

/** Действия возвращают свой discriminated-результат (ok:true/false) как есть. */
export async function doPay(
  initData: string,
  orderId: string,
  contacts?: { email?: string; phone?: string },
  opts?: { useBonus?: boolean; promoCode?: string },
): Promise<PayResult> {
  // Контакты — из плашки (тикеты 02/05): сервер сохранит их в профиль ДО
  // выставления счёта (гейты email_required/phone_required читают профиль).
  // `useBonus` — только «да/нет»: сколько именно списать, решает сервер той же
  // математикой, что посчитала предложение на экране.
  const resp = await callCabinet({
    action: 'pay',
    initData,
    orderId,
    ...(contacts?.email !== undefined ? { email: contacts.email } : {}),
    ...(contacts?.phone !== undefined ? { phone: contacts.phone } : {}),
    ...(opts?.useBonus ? { useBonus: true } : {}),
    // Промокод уходит тем же запросом: занимает его сервер, в момент создания
    // счёта и под локами. Проверка на экране была лишь обещанием.
    ...(opts?.promoCode ? { promoCode: opts.promoCode } : {}),
  });
  const parsed = resp ? payResultSchema.safeParse(resp.json) : null;
  if (parsed?.success) return withMessage(parsed.data);
  return { ok: false, error: GENERIC_ERROR, message: NETWORK_ERROR_TEXT };
}

/** Проверить промокод по заказу: «что он даст». Ничего не занимает. */
export async function checkPromo(
  initData: string,
  orderId: string,
  promoCode: string,
): Promise<PromoCheckResult> {
  const resp = await callCabinet({ action: 'promo-check', initData, orderId, promoCode });
  const parsed = resp ? promoCheckResultSchema.safeParse(resp.json) : null;
  if (parsed?.success) return parsed.data;
  return { ok: false, error: GENERIC_ERROR, message: NETWORK_ERROR_TEXT };
}

const paymentProblemResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), duplicate: z.boolean(), text: z.string() }),
  z.object({ ok: z.literal(false), error: z.string(), message: z.string().optional() }),
]);

export type PaymentProblemResult =
  | Extract<z.infer<typeof paymentProblemResultSchema>, { ok: true }>
  | { ok: false; error: string; message: string };

/** «Проблема с оплатой» — фаза ДО выпуска карты (тикет 10). */
export async function doReportPaymentProblem(
  initData: string,
  orderId: string,
  problemType: PaymentProblemType,
  comment?: string,
): Promise<PaymentProblemResult> {
  const resp = await callCabinet({
    action: 'payment-problem',
    initData,
    orderId,
    problemType,
    ...(comment !== undefined ? { comment } : {}),
  });
  const parsed = resp ? paymentProblemResultSchema.safeParse(resp.json) : null;
  if (parsed?.success) {
    if (parsed.data.ok) return parsed.data;
    return {
      ok: false,
      error: parsed.data.error,
      message: parsed.data.message ?? errorTextFor(parsed.data.error),
    };
  }
  return { ok: false, error: GENERIC_ERROR, message: NETWORK_ERROR_TEXT };
}

const updateContactsResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string(), message: z.string().optional() }),
]);

export type UpdateContactsResult =
  | { ok: true }
  | { ok: false; error: string; message: string };

/** Экран «Профиль» (тикет 08): правка контактов вне заказа. */
export async function doUpdateContacts(
  initData: string,
  contacts: { email?: string; phone?: string },
): Promise<UpdateContactsResult> {
  const resp = await callCabinet({ action: 'update-contacts', initData, ...contacts });
  const parsed = resp ? updateContactsResultSchema.safeParse(resp.json) : null;
  if (parsed?.success) {
    if (parsed.data.ok) return parsed.data;
    return {
      ok: false,
      error: parsed.data.error,
      message: parsed.data.message ?? errorTextFor(parsed.data.error),
    };
  }
  return { ok: false, error: GENERIC_ERROR, message: NETWORK_ERROR_TEXT };
}

/** Заказ из кнопочного каталога Mini App (форма результата — как у repeat). */
export type ProposePayload = {
  slug: string;
  tierName?: string;
  tierPeriod?: 'month' | 'quarter' | 'year';
  amountUsdCents?: number;
};

export async function doPropose(initData: string, payload: ProposePayload): Promise<OrderCreationResult> {
  const resp = await callCabinet({ action: 'propose', initData, ...payload });
  const parsed = resp ? orderCreationResultSchema.safeParse(resp.json) : null;
  if (parsed?.success) return withMessage(parsed.data);
  return { ok: false, error: GENERIC_ERROR, message: NETWORK_ERROR_TEXT };
}

// ─── Пост-выпускные действия (ТЗ «клиентский путь» §6) ─────────────────────

const paymentIssueResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), duplicate: z.boolean() }),
  z.object({ ok: z.literal(false), error: z.string(), message: z.string().optional() }),
]);

export type PaymentIssueResult =
  | Extract<z.infer<typeof paymentIssueResultSchema>, { ok: true }>
  | CabinetFailure;

/** «Не проходит оплата?»: тип проблемы + контекст заказа уходят оператору. */
export async function doReportPaymentIssue(
  initData: string,
  orderId: string,
  issueType: PaymentIssueType,
  comment?: string,
): Promise<PaymentIssueResult> {
  const resp = await callCabinet({
    action: 'payment-issue',
    initData,
    orderId,
    issueType,
    ...(comment ? { comment } : {}),
  });
  const parsed = resp ? paymentIssueResultSchema.safeParse(resp.json) : null;
  if (parsed?.success) return withMessage(parsed.data);
  // Ответ пришёл, но не наш контракт (401 протухшей сессии, 429 и т.п.) — это
  // не «нет сети», честнее позвать переоткрыть кабинет.
  if (resp) {
    return { ok: false, error: 'unexpected', message: 'Не получилось. Переоткрой кабинет и попробуй ещё раз.' };
  }
  return { ok: false, error: GENERIC_ERROR, message: 'Сеть недоступна. Попробуй ещё раз.' };
}

const cancelOrderResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), invoiceClosed: z.boolean(), message: z.string() }),
  z.object({ ok: z.literal(false), error: z.string(), message: z.string().optional() }),
]);

export type CancelOrderResult =
  | Extract<z.infer<typeof cancelOrderResultSchema>, { ok: true }>
  | CabinetFailure;

/** «Отменить заказ» — клиент передумал платить (до оплаты). */
export async function doCancelOrder(
  initData: string,
  orderId: string,
): Promise<CancelOrderResult> {
  const resp = await callCabinet({ action: 'cancel', initData, orderId });
  const parsed = resp ? cancelOrderResultSchema.safeParse(resp.json) : null;
  if (parsed?.success) return withMessage(parsed.data);
  // Ответ пришёл, но не наш контракт (401 протухшей сессии, 429): «нет сети»
  // здесь врёт и зовёт долбить кнопку, которая уходит клиенту в деньги.
  if (resp) {
    return {
      ok: false,
      error: 'unexpected',
      message: 'Не получилось. Переоткрой кабинет и попробуй ещё раз.',
    };
  }
  return { ok: false, error: GENERIC_ERROR, message: NETWORK_ERROR_TEXT };
}

const subscriptionPaidResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string(), message: z.string().optional() }),
]);

export type SubscriptionPaidResult =
  | Extract<z.infer<typeof subscriptionPaidResultSchema>, { ok: true }>
  | CabinetFailure;

/** «Подписка оплачена» — клиент подтвердил успех на сайте сервиса. */
export async function doMarkSubscriptionPaid(
  initData: string,
  orderId: string,
): Promise<SubscriptionPaidResult> {
  const resp = await callCabinet({ action: 'subscription-paid', initData, orderId });
  const parsed = resp ? subscriptionPaidResultSchema.safeParse(resp.json) : null;
  if (parsed?.success) return withMessage(parsed.data);
  if (resp) {
    return { ok: false, error: 'unexpected', message: 'Не получилось. Переоткрой кабинет и попробуй ещё раз.' };
  }
  return { ok: false, error: GENERIC_ERROR, message: 'Сеть недоступна. Попробуй ещё раз.' };
}

