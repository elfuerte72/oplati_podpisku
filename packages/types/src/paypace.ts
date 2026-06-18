import { z } from 'zod';

/**
 * Контракт app.pay.space — выпуск виртуальных USD-карт (VCC).
 *
 * Подтверждён официальной OpenAPI-докой (`api-1.json`, 2026-06-16). Перед
 * prod-доверием — один живой вызов (урок Love&Pay: тестовая панель кабинета врала).
 *
 * Формат wire:
 *  - Обёртка ответа: `{ success: true, data }` | `{ success: false, error }`.
 *  - Суммы — строки-доллары (`"10.00"`). Конвертация в USD-центы — на границе
 *    клиента (`apps/web/lib/pay-space/format.ts`); внутренний инвариант проекта
 *    «деньги — integer в минимальных единицах» сохраняется.
 *  - Имена полей — в основном `snake_case`; у `release`/`info` провайдер
 *    отдаёт `camelCase` (cardId/cardNo/expDate) — это НЕ опечатка, так в доке.
 *
 * Здесь — только Zod-схемы wire-формата (валидируют `data` реальных ответов).
 * Доменные типы запросов/результатов (camelCase, центы) живут в клиенте.
 */

/**
 * Денежная величина в ответах PaySpace. Контракт НЕстабилен: часть эндпоинтов
 * отдаёт суммы строкой ("18.43"), а `card.balance` в create — числом (1.0).
 * Принимаем оба; конверсия в центы — `dollarStringToUsdCents` (тоже принимает оба).
 * Зафиксировано живым вызовом 2026-06-18.
 */
export const paySpaceMoney = z.union([z.string(), z.number()]);

// ─── Ошибка ────────────────────────────────────────────────────────────────

export const paySpaceErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});
export type PaySpaceError = z.infer<typeof paySpaceErrorSchema>;

// ─── Карта в ответе create (POST /vcc/card/create/) ──────────────────────────

export const paySpaceVccCardSchema = z.object({
  card_id: z.string(),
  /** Полный PAN (16 цифр) — НИКОГДА не логировать и не хранить в БД. */
  card_no: z.string(),
  currency: z.string(),
  /** Срок действия. По доке YYYY-MM-DD, но живой вызов вернул MM/YY ("06/27"). */
  exp_date: z.string(),
  /** CVV — НИКОГДА не логировать; уходит клиенту только сообщением в Telegram. */
  cvv: z.string(),
  /** Баланс карты (строка или число — см. paySpaceMoney). */
  balance: paySpaceMoney,
  callback_url: z.string().nullable(),
});
export type PaySpaceVccCard = z.infer<typeof paySpaceVccCardSchema>;

export const paySpaceCreateCardDataSchema = z.object({
  card: paySpaceVccCardSchema,
  /** Сеть USDT, из которой списаны средства (trc20/bep20/erc20). */
  network: z.string(),
});
export type PaySpaceCreateCardData = z.infer<typeof paySpaceCreateCardDataSchema>;

// ─── Async-операции topup/withdraw: { request_id, status } ───────────────────

export const paySpaceAsyncOpStatus = z.enum(['pending', 'completed', 'failed']);
export type PaySpaceAsyncOpStatus = z.infer<typeof paySpaceAsyncOpStatus>;

export const paySpaceAsyncOpDataSchema = z.object({
  request_id: z.string(),
  status: paySpaceAsyncOpStatus,
});
export type PaySpaceAsyncOpData = z.infer<typeof paySpaceAsyncOpDataSchema>;

// ─── Проверка пополнения (GET /vcc/card/topup/check/) ────────────────────────

export const paySpaceTopupCheckDataSchema = z.object({
  card_id: z.string(),
  request_id: z.string(),
  bal_type: z.string(),
  /** Баланс карты ПОСЛЕ пополнения (строка или число). */
  total_amt: paySpaceMoney,
  recharge_amt: paySpaceMoney,
  op_time: z.string(),
});
export type PaySpaceTopupCheckData = z.infer<typeof paySpaceTopupCheckDataSchema>;

// ─── Проверка вывода (GET /vcc/card/withdraw/check/) ─────────────────────────

export const paySpaceWithdrawCheckDataSchema = z.object({
  card_id: z.string(),
  request_id: z.string(),
  bal_type: z.string(),
  total_amt: paySpaceMoney,
  withdraw_amt: paySpaceMoney,
  op_time: z.string(),
});
export type PaySpaceWithdrawCheckData = z.infer<typeof paySpaceWithdrawCheckDataSchema>;

// ─── Закрытие карты (POST /vcc/card/release/) — camelCase ────────────────────

export const paySpaceReleaseDataSchema = z.object({
  cardId: z.string(),
  /** Возвращённый на VCC-баланс остаток карты (строка или число). */
  releaseBal: paySpaceMoney,
});
export type PaySpaceReleaseData = z.infer<typeof paySpaceReleaseDataSchema>;

// ─── Инфо о карте (GET /vcc/card/info/) — camelCase ──────────────────────────
//
// Статусы карты (строки): "0" Deactivated · "1" Activated · "2" Frozen ·
// "3" Expired · "4" Locked · "9" Inactivated. Держим строкой — маппинг в клиенте.

export const paySpaceCardInfoDataSchema = z.object({
  cardId: z.string(),
  cardNo: z.string(),
  cvv: z.string(),
  /** Срок действия MM/YY. */
  expDate: z.string(),
  status: z.string(),
  cardBal: paySpaceMoney,
  usedAmt: paySpaceMoney,
  totalAmt: paySpaceMoney,
  // Опциональные поля провайдер отдаёт и как null (живой вызов: card_email=null).
  settleAmt: paySpaceMoney.nullish(),
  createTime: z.string().nullish(),
  cardType: z.string().nullish(),
  productCode: z.string().nullish(),
  card_email: z.string().nullish(),
});
export type PaySpaceCardInfoData = z.infer<typeof paySpaceCardInfoDataSchema>;

// ─── Баланс VCC-аккаунта (GET /vcc/user/balance/) ────────────────────────────

export const paySpaceUserBalanceDataSchema = z.object({
  /** Доступный баланс (строка или число). */
  balance: paySpaceMoney,
  /** Замороженная сумма (строка или число). */
  pending: paySpaceMoney,
  currency: z.string(),
});
export type PaySpaceUserBalanceData = z.infer<typeof paySpaceUserBalanceDataSchema>;
