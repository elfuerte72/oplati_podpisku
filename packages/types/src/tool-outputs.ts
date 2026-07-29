import { z } from 'zod';

/**
 * Формы `output`/`input` вызовов инструментов агента — для разбора `toolCalls`
 * из ответа `/api/chat` в карточки веб-чата.
 *
 * Зачем схемы, а не самописные type-guard'ы (инвариант 5 «Zod на всех
 * границах»): парсер живёт на клиентском слое и получает `unknown`, а
 * контракт tool'ов меняется вместе с бэкендом. Проверки «вручную» расходились
 * с реальностью молча — карточка просто переставала рисоваться.
 *
 * ⚠️ Схемы намеренно СНИСХОДИТЕЛЬНЫЕ:
 *  - `passthrough()` — новое поле в ответе tool'а не должно ломать старый UI;
 *  - `.catch(...)` на необязательных полях — кривое значение даёт дефолт, а не
 *    выбрасывает карточку целиком. Строгими остаются только те поля, без
 *    которых карточку нарисовать физически нечем (id, суммы, ссылки): для них
 *    пропуск — правильное поведение, лучше не показать карточку, чем показать
 *    пустую.
 */

/** Одна запись `ToolCallLog` (@oplati/agent) на границе с клиентом. */
export const chatToolCallSchema = z
  .object({
    name: z.string().optional(),
    input: z.unknown().optional(),
    output: z.unknown().optional(),
    isError: z.boolean().optional(),
  })
  .passthrough();
export type ChatToolCall = z.infer<typeof chatToolCallSchema>;

/** `input` вызова: из него берётся человекочитаемое имя сервиса и orderId. */
export const chatToolInputSchema = z
  .object({
    orderId: z.string().optional().catch(undefined),
    serviceName: z.string().optional().catch(undefined),
    customDescription: z.string().optional().catch(undefined),
  })
  .passthrough();

/** Элемент выдачи `search_catalog`. Без id или имени карточку строить не из чего. */
export const searchCatalogItemSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    requiresKyc: z.boolean().catch(false).default(false),
  })
  .passthrough();

export const proposeOrderOutputSchema = z
  .object({
    orderId: z.string().min(1),
    shortId: z.string().min(1),
    totalRubKopecks: z.number().int().nonnegative(),
    expiresAt: z.string().min(1),
    /**
     * Старые ответы поля не содержали — тогда цена в долларах не показывается.
     * Целое и неотрицательное: деньги живут в минимальных единицах (инвариант 3),
     * дробные или отрицательные центы — признак сломанного контракта.
     */
    originalAmountUsdCents: z.number().int().nonnegative().nullish().catch(null),
    isCustom: z.boolean().catch(false).default(false),
    /** Надбавка платёжной системы на плательщика, %; 0 — её нет. */
    buyerFeePercent: z.number().finite().catch(0).default(0),
  })
  .passthrough();

export const confirmOrderOutputSchema = z
  .object({
    paymentUrl: z.string().min(1),
    expiresAt: z.string().min(1),
    qrPayload: z.string().nullish().catch(null),
  })
  .passthrough();

export const requestHumanOutputSchema = z
  .object({
    slaHours: z.number().finite().catch(0).default(0),
  })
  .passthrough();

/**
 * Ошибка tool'а с маркером гейта привязки Telegram. Единственная «полезная»
 * ошибка: по ней веб-чат рисует кнопку привязки вместо ссылки на оплату.
 */
export const toolErrorOutputSchema = z
  .object({
    error: z.string().catch(''),
  })
  .passthrough();

/** Маркер, по которому распознаётся отказ `confirm_order` без Telegram. */
export const TELEGRAM_LINK_REQUIRED_MARKER = 'telegram_link_required';
