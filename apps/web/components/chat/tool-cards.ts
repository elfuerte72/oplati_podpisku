import {
  chatToolCallSchema,
  chatToolInputSchema,
  confirmOrderOutputSchema,
  proposeOrderOutputSchema,
  requestHumanOutputSchema,
  searchCatalogItemSchema,
  toolErrorOutputSchema,
  TELEGRAM_LINK_REQUIRED_MARKER,
} from '@oplati/types';

/**
 * Парсинг `toolCalls` из ответа /api/chat в данные для комикс-карточек.
 *
 * Источник — `ToolCallLog[]` (@oplati/agent): { name, input, output, isError }.
 * Это клиентский слой, форме доверять нельзя, поэтому всё проходит через схемы
 * из `@oplati/types` (инвариант 5). Раньше здесь были самописные type-guard'ы:
 * они дублировали контракт tool'ов и расходились с ним молча — карточка просто
 * переставала рисоваться, без единого сигнала.
 *
 * Разбор снисходительный и повызовный: невалидная запись пропускается,
 * остальные карточки рисуются. `web_search` и ошибочные вызовы (кроме гейта
 * привязки Telegram) карточек не дают.
 */

export type ChatCard =
  | { type: 'catalog'; items: { id: string; name: string; requiresKyc: boolean }[] }
  | {
      type: 'order';
      orderId: string;
      shortId: string;
      service: string;
      totalKopecks: number;
      /** Оригинальная цена подписки в USD-центах; `null` — старый ответ без поля. */
      usdCents: number | null;
      expiresAt: string;
      isCustom: boolean;
      /**
       * Надбавка платёжной системы на плательщика, % (0 — её нет). Приходит с
       * сервера в кнопочном пути (`/api/orders/propose`); в AI-пути tool не
       * возвращает её вовсе — тогда 0 и предупреждение не рендерится.
       */
      buyerFeePercent: number;
    }
  // orderId — для кнопки «Проблема с оплатой?» под платёжной карточкой
  // (тикет 10); у карточек из AI tool-calls его нет (не парсится) — кнопка
  // тогда не показывается.
  | {
      type: 'payment';
      paymentUrl: string;
      qrPayload: string | null;
      expiresAt: string;
      orderId?: string;
    }
  | { type: 'operator'; slaHours: number }
  // Гейт привязки: confirm_order отклонён, у веб-пользователя нет Telegram.
  | { type: 'telegram_link'; orderId: string | null };

export function parseToolCards(toolCalls: unknown): ChatCard[] {
  if (!Array.isArray(toolCalls)) return [];
  const cards: ChatCard[] = [];

  for (const raw of toolCalls) {
    const call = chatToolCallSchema.safeParse(raw);
    if (!call.success) continue;
    const { name, input, output, isError } = call.data;

    // Единственная «полезная» ошибка tool'а: confirm_order отклонён гейтом
    // привязки Telegram (см. TelegramLinkRequiredError) — рисуем кнопку привязки.
    if (isError === true) {
      if (name !== 'confirm_order') continue;
      const err = toolErrorOutputSchema.safeParse(output);
      if (!err.success || !err.data.error.includes(TELEGRAM_LINK_REQUIRED_MARKER)) continue;
      cards.push({ type: 'telegram_link', orderId: parseInput(input).orderId ?? null });
      continue;
    }

    if (name === 'search_catalog') {
      if (!Array.isArray(output)) continue;
      const items = output.flatMap((item) => {
        const parsed = searchCatalogItemSchema.safeParse(item);
        return parsed.success
          ? [{ id: parsed.data.id, name: parsed.data.name, requiresKyc: parsed.data.requiresKyc }]
          : [];
      });
      if (items.length > 0) cards.push({ type: 'catalog', items });
      continue;
    }

    if (name === 'propose_order') {
      const parsed = proposeOrderOutputSchema.safeParse(output);
      if (!parsed.success) continue;
      const o = parsed.data;
      const fromInput = parseInput(input);
      cards.push({
        type: 'order',
        orderId: o.orderId,
        shortId: o.shortId,
        service: fromInput.serviceName ?? fromInput.customDescription ?? `Заказ ${o.shortId}`,
        totalKopecks: o.totalRubKopecks,
        usdCents: o.originalAmountUsdCents ?? null,
        expiresAt: o.expiresAt,
        isCustom: o.isCustom,
        buyerFeePercent: o.buyerFeePercent,
      });
      continue;
    }

    if (name === 'confirm_order') {
      const parsed = confirmOrderOutputSchema.safeParse(output);
      if (!parsed.success) continue;
      cards.push({
        type: 'payment',
        paymentUrl: parsed.data.paymentUrl,
        qrPayload: parsed.data.qrPayload ?? null,
        expiresAt: parsed.data.expiresAt,
      });
      continue;
    }

    if (name === 'request_human') {
      const parsed = requestHumanOutputSchema.safeParse(output);
      if (!parsed.success) continue;
      cards.push({ type: 'operator', slaHours: parsed.data.slaHours });
      continue;
    }
  }

  return cards;
}

/** `input` вызова может быть чем угодно (в том числе null) — не роняем разбор. */
function parseInput(input: unknown): {
  orderId?: string;
  serviceName?: string;
  customDescription?: string;
} {
  const parsed = chatToolInputSchema.safeParse(input);
  return parsed.success ? parsed.data : {};
}
