import 'server-only';

import type { ConfirmOrderResult } from '@oplati/agent';

import { serverEnv } from '../env.server.ts';
import { childLogger } from '../logger.ts';

/**
 * Tool `confirm_order`. Self-call в `/api/payments/create` с `X-Internal-Token`.
 * Возвращает paymentUrl, qrPayload, expiresAt — это то, что AI озвучивает
 * пользователю.
 */

const log = childLogger('tool.confirm_order');

export async function confirmOrder(input: {
  orderId: string;
  paymentMethod?: 'sbp' | 'card';
}): Promise<ConfirmOrderResult> {
  const internalToken = serverEnv.INTERNAL_API_TOKEN;
  if (!internalToken) {
    throw new Error('confirm_order: INTERNAL_API_TOKEN не задан');
  }

  const baseUrl = serverEnv.APP_URL.replace(/\/$/, '');
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
