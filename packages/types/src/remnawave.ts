import { z } from 'zod';

/**
 * Zod-контракт Remnawave — панель VPN-подписок (наш продукт «VPN Оплатишки»).
 * Контракт подтверждён живыми вызовами 2026-07-21 (create / by-telegram-id /
 * revoke / delete). Формат ответа панели — envelope `{ response: ... }`;
 * полезное всегда внутри `response`.
 */

export const remnawaveUserStatus = z.enum(['ACTIVE', 'DISABLED', 'LIMITED', 'EXPIRED']);
export type RemnawaveUserStatus = z.infer<typeof remnawaveUserStatus>;

/**
 * Юзер панели. Схема осознанно узкая: только поля, нужные бэкенду (остальные
 * ключи ответа Zod по умолчанию отбрасывает — дрейф необязательных полей не
 * ломает интеграцию). Важно: `uuid` — главный id для PATCH/revoke/DELETE,
 * НЕ `vlessUuid` (id протокола). `shortUuid` — хвост ссылки-подписки,
 * МЕНЯЕТСЯ при revoke (перевыпуск ссылки).
 */
export const remnawaveUserSchema = z.object({
  uuid: z.string().uuid(),
  username: z.string().min(1),
  shortUuid: z.string().min(1),
  subscriptionUrl: z.string().url(),
  status: remnawaveUserStatus,
  // ISO-8601 UTC; coerce — панель отдаёт строку.
  expireAt: z.coerce.date(),
  telegramId: z.number().int().nullable().optional(),
});
export type RemnawaveUser = z.infer<typeof remnawaveUserSchema>;

/**
 * GET /users/by-telegram-id/{id} → массив юзеров. Несуществующий telegramId —
 * это HTTP 200 + пустой массив (НЕ 404; подтверждено живым вызовом).
 */
export const remnawaveUsersByTelegramIdResponseSchema = z.object({
  response: z.array(remnawaveUserSchema),
});

/** POST /users (201 Created) и POST /users/{uuid}/actions/revoke (200). */
export const remnawaveUserResponseSchema = z.object({
  response: remnawaveUserSchema,
});

/** DELETE /users/{uuid} → `{ response: { isDeleted: true } }`. */
export const remnawaveDeleteResponseSchema = z.object({
  response: z.object({ isDeleted: z.boolean() }),
});
