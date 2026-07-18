import 'server-only';

import * as Sentry from '@sentry/nextjs';

import type { ConfirmOrderResult } from '@oplati/agent';
import { getDb, getOrderById, getUserTelegramId } from '@oplati/db';

import { serverEnv } from '../env.server.ts';
import { childLogger } from '../logger.ts';

/**
 * Tool `confirm_order`. Self-call в `/api/payments/create` с `X-Internal-Token`.
 * Возвращает paymentUrl, qrPayload, expiresAt — это то, что AI озвучивает
 * пользователю.
 *
 * Ownership-check (P2-14): если передан `userId` (вызов от AI через
 * createToolHandlers — мы знаем userId из контекста разговора) — проверяем,
 * что заказ принадлежит этому пользователю. Если нет — отказываем, чтобы
 * исключить случай галлюцинации/инъекции с чужим orderId.
 *
 * При вызове из callback-handler'а (нажатие inline-кнопки) `userId` не
 * передаётся — там доверие установлено самим Telegram'ом: кнопка прикреплена
 * к сообщению пользователя, владельца заказа.
 */

const log = childLogger('tool.confirm_order');

/**
 * Маркер «нужно привязать Telegram» — по нему /api/orders/confirm и веб-UI
 * отличают этот кейс от прочих ошибок (и parseToolCards рисует кнопку привязки).
 */
export const TELEGRAM_LINK_REQUIRED = 'telegram_link_required';

export class TelegramLinkRequiredError extends Error {
  constructor() {
    super(
      `${TELEGRAM_LINK_REQUIRED}: у пользователя не привязан Telegram. Подтверждение оплаты, чек и доступы доставляются только сообщением в Telegram, поэтому счёт не создан. Объясни это пользователю одной фразой и попроси нажать кнопку «Связать Telegram» под сообщением.`,
    );
    this.name = 'TelegramLinkRequiredError';
  }
}

/**
 * `/api/payments/create` ответил 503 `provider_unavailable` — лежит транспорт
 * до L&P (squid-прокси / сеть / 5xx провайдера). Это НЕ ошибка запроса: заказ
 * жив, счёт можно выставить позже. Текст читает и AI (tool-loop отдаёт ошибку
 * модели) — формулировка объясняет, что сказать пользователю.
 */
export class PaymentProviderUnavailableError extends Error {
  constructor() {
    super(
      'payment_provider_unavailable: приём оплаты временно недоступен — технический сбой на стороне платёжной системы. Счёт не создан, заказ сохранён. Скажи пользователю попробовать снова через несколько минут.',
    );
    this.name = 'PaymentProviderUnavailableError';
  }
}

export async function confirmOrder(input: {
  orderId: string;
  paymentMethod?: 'sbp' | 'card';
  userId?: string;
}): Promise<ConfirmOrderResult> {
  if (input.userId) {
    const order = await getOrderById(getDb(), input.orderId);
    if (!order || order.userId !== input.userId) {
      log.warn({
        event: 'tool.confirm_order.ownership_mismatch',
        orderId: input.orderId,
        userId: input.userId,
      });
      Sentry.captureMessage('confirm_order: ownership mismatch', {
        level: 'warning',
        tags: { source: 'tool.confirm_order' },
        extra: { orderId: input.orderId, userId: input.userId },
      });
      throw new Error('confirm_order: заказ не найден или принадлежит другому пользователю');
    }

    // Гейт привязки (только веб-канал: из Telegram userId либо не передаётся,
    // либо у пользователя по определению есть telegram_id). Результат заказа —
    // уведомление об оплате и, в фазе 2, реквизиты карты — уходит ТОЛЬКО
    // сообщением в Telegram, поэтому без привязки счёт не выставляем.
    const telegramId = await getUserTelegramId(getDb(), input.userId);
    if (telegramId === null) {
      log.info({ event: 'tool.confirm_order.telegram_link_required', orderId: input.orderId });
      throw new TelegramLinkRequiredError();
    }
  }

  const internalToken = serverEnv.INTERNAL_API_TOKEN;
  if (!internalToken) {
    throw new Error('confirm_order: INTERNAL_API_TOKEN не задан');
  }

  // Self-call должен идти в ТОТ ЖЕ deployment. На preview APP_URL указывает на
  // production (где нет L&P-ключей и INTERNAL_API_TOKEN), поэтому self-call на
  // APP_URL ловит 401/недонастроенный L&P. Берём собственный URL текущего
  // deployment'а из VERCEL_URL; APP_URL остаётся fallback'ом (локальная разработка).
  const ownHost = process.env.VERCEL_URL;
  const baseUrl = ownHost ? `https://${ownHost}` : serverEnv.APP_URL.replace(/\/$/, '');
  const url = `${baseUrl}/api/payments/create`;

  log.info({ event: 'tool.confirm_order.start', orderId: input.orderId });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60_000);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': internalToken,
      },
      body: JSON.stringify({
        orderId: input.orderId,
        ...(input.paymentMethod !== undefined ? { paymentMethod: input.paymentMethod } : {}),
      }),
      signal: controller.signal,
    });

    const respText = await resp.text();
    if (!resp.ok) {
      log.error({
        event: 'tool.confirm_order.failed',
        orderId: input.orderId,
        httpStatus: resp.status,
        body: respText.slice(0, 500),
      });
      if (resp.status === 503 && respText.includes('provider_unavailable')) {
        throw new PaymentProviderUnavailableError();
      }
      throw new Error(`confirm_order: /api/payments/create вернул ${resp.status}: ${respText.slice(0, 200)}`);
    }

    let parsed: {
      ok?: boolean;
      paymentUrl?: string;
      qrPayload?: string | null;
      expiresAt?: string;
    };
    try {
      parsed = JSON.parse(respText);
    } catch (err) {
      throw new Error(`confirm_order: невалидный JSON в ответе: ${(err as Error).message}`);
    }

    if (!parsed.ok || !parsed.paymentUrl || !parsed.expiresAt) {
      throw new Error(`confirm_order: неполный ответ /api/payments/create: ${respText.slice(0, 200)}`);
    }

    log.info({
      event: 'tool.confirm_order.ok',
      orderId: input.orderId,
    });

    return {
      paymentUrl: parsed.paymentUrl,
      qrPayload: parsed.qrPayload ?? null,
      expiresAt: parsed.expiresAt,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
