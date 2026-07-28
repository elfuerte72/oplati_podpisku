/**
 * Парсинг `toolCalls` из ответа /api/chat в данные для комикс-карточек.
 *
 * Источник — `ToolCallLog[]` (@oplati/agent): { name, input, output, isError }.
 * Здесь — клиентский слой, поэтому не доверяем форме слепо и нарезаем через
 * type-guard'ы (output типизирован как unknown на границе). web_search и
 * ошибочные вызовы пропускаем.
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
  | { type: 'payment'; paymentUrl: string; qrPayload: string | null; expiresAt: string }
  | { type: 'operator'; slaHours: number }
  // Гейт привязки: confirm_order отклонён, у веб-пользователя нет Telegram.
  | { type: 'telegram_link'; orderId: string | null };

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
function asStr(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
function asNum(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function parseToolCards(toolCalls: unknown): ChatCard[] {
  if (!Array.isArray(toolCalls)) return [];
  const cards: ChatCard[] = [];

  for (const tc of toolCalls) {
    if (!isObj(tc)) continue;

    // Единственная «полезная» ошибка tool'а: confirm_order отклонён гейтом
    // привязки Telegram (см. TelegramLinkRequiredError) — рисуем кнопку привязки.
    if (tc.isError === true) {
      const errName = asStr(tc.name);
      const errOut = tc.output;
      if (
        errName === 'confirm_order' &&
        isObj(errOut) &&
        (asStr(errOut.error) ?? '').includes('telegram_link_required')
      ) {
        const input = isObj(tc.input) ? tc.input : {};
        cards.push({ type: 'telegram_link', orderId: asStr(input.orderId) ?? null });
      }
      continue;
    }

    const name = asStr(tc.name);
    const output = tc.output;

    if (name === 'search_catalog' && Array.isArray(output)) {
      const items = output
        .filter(isObj)
        .map((o) => ({
          id: asStr(o.id) ?? '',
          name: asStr(o.name) ?? '',
          requiresKyc: o.requiresKyc === true,
        }))
        .filter((o) => o.id.length > 0 && o.name.length > 0);
      if (items.length > 0) cards.push({ type: 'catalog', items });
      continue;
    }

    if (name === 'propose_order' && isObj(output)) {
      const orderId = asStr(output.orderId);
      const shortId = asStr(output.shortId);
      const totalKopecks = asNum(output.totalRubKopecks);
      const expiresAt = asStr(output.expiresAt);
      if (orderId && shortId && totalKopecks !== undefined && expiresAt) {
        const input = isObj(tc.input) ? tc.input : {};
        const service =
          asStr(input.serviceName) ?? asStr(input.customDescription) ?? `Заказ ${shortId}`;
        cards.push({
          type: 'order',
          orderId,
          shortId,
          service,
          totalKopecks,
          usdCents: asNum(output.originalAmountUsdCents) ?? null,
          expiresAt,
          isCustom: output.isCustom === true,
          buyerFeePercent: asNum(output.buyerFeePercent) ?? 0,
        });
      }
      continue;
    }

    if (name === 'confirm_order' && isObj(output)) {
      const paymentUrl = asStr(output.paymentUrl);
      const expiresAt = asStr(output.expiresAt);
      if (paymentUrl && expiresAt) {
        cards.push({
          type: 'payment',
          paymentUrl,
          qrPayload: asStr(output.qrPayload) ?? null,
          expiresAt,
        });
      }
      continue;
    }

    if (name === 'request_human' && isObj(output)) {
      cards.push({ type: 'operator', slaHours: asNum(output.slaHours) ?? 0 });
      continue;
    }
  }

  return cards;
}
