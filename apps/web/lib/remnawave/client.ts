import {
  remnawaveDeleteResponseSchema,
  remnawaveUserResponseSchema,
  remnawaveUsersByTelegramIdResponseSchema,
  type RemnawaveUser,
} from '@oplati/types';
import type { z } from 'zod';

import type { Logger } from '../logger.ts';
import { RemnawaveApiError, RemnawaveContractError } from './errors.ts';

/**
 * HTTP-клиент панели Remnawave (VPN Оплатишки). Контракт подтверждён живыми
 * вызовами 2026-07-21: create (201) / by-telegram-id (200 + массив, пустой =
 * юзера нет) / actions/revoke (200, НОВЫЙ shortUuid+subscriptionUrl, expireAt
 * сохраняется) / delete (200 { isDeleted }).
 *
 * - База `https://panel.mxpkn8ns.ru/api`; auth `Authorization: Bearer <TOKEN>`.
 * - Ответ панели — envelope `{ response: ... }`, валидируется Zod-схемой из
 *   `@oplati/types`; дрейф → `RemnawaveContractError`.
 * - Все вызовы server-side (кнопка в боте) — токен НИКОГДА не покидает бэкенд
 *   и не логируется.
 * - Timeout 10s (AbortController), без авто-ретраев: флоу интерактивный
 *   (webhook Telegram), пользователь может просто нажать кнопку ещё раз.
 */

const DEFAULT_TIMEOUT_MS = 10_000;

export type RemnawaveClientOptions = {
  token: string;
  baseUrl: string;
  /** Внутренний squad, в который кладём юзера (иначе подписка пустая). */
  squadUuid: string;
  /** Лимит трафика в байтах; 0 = безлимит. */
  trafficLimitBytes: number;
  logger: Logger;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export type CreateVpnUserInput = {
  /** Telegram ID клиента (строка — как в users.telegram_id). */
  telegramId: string;
  /** Срок действия доступа (ISO UTC уходит в панель). */
  expireAt: Date;
};

export type RemnawaveClient = {
  findUserByTelegramId(telegramId: string): Promise<RemnawaveUser | null>;
  createUser(input: CreateVpnUserInput): Promise<RemnawaveUser>;
  /** Перевыпуск ссылки-подписки: старый shortUuid умирает, expireAt не меняется. */
  revokeSubscription(uuid: string): Promise<RemnawaveUser>;
  deleteUser(uuid: string): Promise<boolean>;
};

/** username юзера панели: детерминирован от telegramId (уникален, латиница/цифры/_). */
export function remnawaveUsername(telegramId: string): string {
  return `tg_${telegramId}`;
}

export function createRemnawaveClient(options: RemnawaveClientOptions): RemnawaveClient {
  const {
    token,
    baseUrl,
    squadUuid,
    trafficLimitBytes,
    logger,
    fetchImpl = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;
  const base = baseUrl.replace(/\/$/, '');

  async function request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    schema: z.ZodType<T>,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    let res: Response;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const durationMs = Date.now() - startedAt;
    if (!res.ok) {
      // Тело ошибки не логируем целиком (может содержать ссылки-подписки) —
      // статуса и пути достаточно для диагностики.
      logger.warn({ event: 'remnawave.api_error', method, path, status: res.status, durationMs });
      throw new RemnawaveApiError(`Remnawave ${method} ${path} → HTTP ${res.status}`, res.status);
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new RemnawaveContractError(`Remnawave ${method} ${path}: ответ не JSON`);
    }

    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      logger.error({
        event: 'remnawave.contract_drift',
        method,
        path,
        issues: parsed.error.issues.slice(0, 5),
      });
      throw new RemnawaveContractError(
        `Remnawave ${method} ${path}: тело не соответствует контракту`,
      );
    }

    logger.debug({ event: 'remnawave.request_ok', method, path, durationMs });
    return parsed.data;
  }

  return {
    async findUserByTelegramId(telegramId) {
      const data = await request(
        'GET',
        `/users/by-telegram-id/${encodeURIComponent(telegramId)}`,
        remnawaveUsersByTelegramIdResponseSchema,
      );
      return data.response[0] ?? null;
    },

    async createUser(input) {
      const telegramIdNum = Number(input.telegramId);
      if (!Number.isSafeInteger(telegramIdNum)) {
        throw new RemnawaveContractError(`createUser: telegramId не число: ${input.telegramId}`);
      }
      const data = await request('POST', '/users', remnawaveUserResponseSchema, {
        username: remnawaveUsername(input.telegramId),
        telegramId: telegramIdNum,
        expireAt: input.expireAt.toISOString(),
        trafficLimitBytes,
        trafficLimitStrategy: 'MONTH',
        activeInternalSquads: [squadUuid],
      });
      return data.response;
    },

    async revokeSubscription(uuid) {
      const data = await request(
        'POST',
        `/users/${encodeURIComponent(uuid)}/actions/revoke`,
        remnawaveUserResponseSchema,
        {},
      );
      return data.response;
    },

    async deleteUser(uuid) {
      const data = await request(
        'DELETE',
        `/users/${encodeURIComponent(uuid)}`,
        remnawaveDeleteResponseSchema,
      );
      return data.response.isDeleted;
    },
  };
}
