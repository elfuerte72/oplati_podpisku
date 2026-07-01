import { z } from 'zod';

/**
 * Реферальные выплаты (Этап E) — способ выплаты, комиссия вывода, маскирование
 * реквизитов и машина статусов заявки. Чистая логика (только zod), тестируется
 * без БД. Источник ставок комиссии — решение владельца (2026-07-01): вывод на
 * карту РФ 3.5%, вывод в крипте (USDT) 1%.
 *
 * БЕЗОПАСНОСТЬ (PCI): полный номер карты (PAN) НИКОГДА не сохраняется и не
 * логируется — `toStoredPayoutDestination` маскирует его на входе (`****1234`).
 * Это инвариант проекта (CLAUDE.md: «Логировать или сохранять полные PAN/CVC
 * карт» — запрещено). CVV/CVC для выплаты НЕ нужен и не собирается: чтобы
 * отправить деньги НА карту, достаточно номера — CVV участвует только в списании.
 *
 * Деньги — USD-центы integer (инвариант проекта). Комиссия — bps (100 bps = 1%).
 */

// ─── Способы выплаты ──────────────────────────────────────────────────────

export const PAYOUT_METHODS = ['card_rub', 'crypto_usdt'] as const;
export type PayoutMethod = (typeof PAYOUT_METHODS)[number];

/** Комиссия вывода по способу (bps). Решение владельца: карта 3.5%, крипта 1%. */
export const REFERRAL_PAYOUT_FEE_BPS: Record<PayoutMethod, number> = {
  card_rub: 350,
  crypto_usdt: 100,
};

/**
 * Комиссия вывода удерживается из брутто-суммы заявки: партнёр запрашивает
 * `grossUsdCents` (он же вычитается из баланса), получает `netUsdCents`. Комиссия
 * округляется ВНИЗ (floor) — не перебираем с партнёра ни цента сверх ставки
 * (симметрично floor у начислений `referralAmountUsdCents`). Наш доход = fee.
 */
export function computePayoutFee(
  method: PayoutMethod,
  grossUsdCents: number,
): { feeBps: number; feeUsdCents: number; netUsdCents: number } {
  const feeBps = REFERRAL_PAYOUT_FEE_BPS[method];
  const feeUsdCents = grossUsdCents > 0 ? Math.floor((grossUsdCents * feeBps) / 10_000) : 0;
  return { feeBps, feeUsdCents, netUsdCents: grossUsdCents - feeUsdCents };
}

// ─── Маскирование PAN (PCI) ───────────────────────────────────────────────

/** Оставляет только цифры номера карты (форматы `1234 5678`, `1234-5678` и т.п.). */
function panDigits(pan: string): string {
  return pan.replace(/\D/g, '');
}

/**
 * Алгоритм Луна — отсев опечаток в номере карты (12–19 цифр). Это НЕ гарантия
 * существования карты, только контрольная сумма: отбрасывает случайный мусор до
 * того, как реквизиты уйдут провайдеру выплат.
 */
export function isValidLuhn(pan: string): boolean {
  const digits = panDigits(pan);
  if (digits.length < 12 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48; // '0'.charCodeAt(0) === 48
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Маскирует PAN до безопасной для хранения/показа формы: `****1234` + last4.
 * Полный номер на выходе не фигурирует — вызывающий обязан не сохранять исходник.
 */
export function maskPan(pan: string): { panMasked: string; last4: string } {
  const digits = panDigits(pan);
  const last4 = digits.slice(-4);
  return { panMasked: `****${last4}`, last4 };
}

// ─── Реквизиты выплаты ────────────────────────────────────────────────────

/** Сети USDT-вывода. Дефолт TRC20 — точная сеть уточняется у владельца (D-REF-6). */
export const USDT_NETWORKS = ['trc20', 'erc20', 'ton'] as const;
export type UsdtNetwork = (typeof USDT_NETWORKS)[number];

/**
 * ВХОДНЫЕ реквизиты от партнёра (с формы кабинета). Для карты содержат полный
 * PAN — он валидируется (Луна), но НЕ хранится: сразу трансформируется
 * `toStoredPayoutDestination`. CVV/CVC не принимаем (для выплаты не нужен).
 */
export const payoutDestinationInputSchema = z.discriminatedUnion('method', [
  z.object({
    method: z.literal('card_rub'),
    pan: z.string().trim().refine(isValidLuhn, 'invalid card number'),
    holderName: z.string().trim().min(1).max(100),
  }),
  z.object({
    method: z.literal('crypto_usdt'),
    address: z.string().trim().min(10).max(120),
    network: z.enum(USDT_NETWORKS),
  }),
]);
export type PayoutDestinationInput = z.infer<typeof payoutDestinationInputSchema>;

/**
 * ХРАНИМЫЕ реквизиты (`referral_payouts.destination`, jsonb). Для карты — только
 * маска + last4 + ФИО держателя; полного PAN здесь нет и быть не может.
 */
export const payoutDestinationStoredSchema = z.discriminatedUnion('method', [
  z.object({
    method: z.literal('card_rub'),
    panMasked: z.string(),
    last4: z.string().length(4),
    holderName: z.string(),
  }),
  z.object({
    method: z.literal('crypto_usdt'),
    address: z.string(),
    network: z.enum(USDT_NETWORKS),
  }),
]);
export type PayoutDestinationStored = z.infer<typeof payoutDestinationStoredSchema>;

/** Трансформирует входные реквизиты в безопасные для хранения (маскирует PAN). */
export function toStoredPayoutDestination(
  input: PayoutDestinationInput,
): PayoutDestinationStored {
  if (input.method === 'card_rub') {
    const { panMasked, last4 } = maskPan(input.pan);
    return { method: 'card_rub', panMasked, last4, holderName: input.holderName };
  }
  return { method: 'crypto_usdt', address: input.address, network: input.network };
}

// ─── Машина статусов заявки на вывод ──────────────────────────────────────

export const PAYOUT_STATUSES = ['requested', 'processing', 'paid', 'rejected'] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

/**
 * Разрешённые переходы заявки. `paid`/`rejected` — терминальные (закрывают
 * заявку, проставляется `settled_at`). `requested→rejected` — отклонение до
 * обработки; `processing→rejected` — провайдер отказал/вернул. Понижений нет.
 */
export const PAYOUT_ALLOWED_TRANSITIONS: Record<PayoutStatus, readonly PayoutStatus[]> = {
  requested: ['processing', 'rejected'],
  processing: ['paid', 'rejected'],
  paid: [],
  rejected: [],
};

export function canTransitionPayout(from: PayoutStatus, to: PayoutStatus): boolean {
  return PAYOUT_ALLOWED_TRANSITIONS[from].includes(to);
}

/** Терминальный статус — заявка закрыта (переходов больше нет). */
export function isTerminalPayoutStatus(status: PayoutStatus): boolean {
  return PAYOUT_ALLOWED_TRANSITIONS[status].length === 0;
}
