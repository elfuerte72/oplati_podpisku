import { z } from 'zod';

/**
 * Telegram Mini App (Web App) `initData`.
 *
 * Когда Mini App открывается внутри Telegram, страница получает
 * `window.Telegram.WebApp.initData` — URL-encoded query-string, подписанную
 * токеном бота (HMAC-SHA256). Здесь — Zod-схема РАСПАРСЕННОГО поля `user`
 * (JSON внутри query-string). Сама проверка подписи живёт в `apps/web`
 * (`lib/telegram/init-data.ts`), потому что требует `node:crypto`, а
 * `@oplati/types` по архитектурному инварианту импортирует только `zod`.
 *
 * Контракт: https://core.telegram.org/bots/webapps#webappinitdata
 * Поля сверх перечисленных Telegram может добавлять — лишние молча отбрасываются.
 */
export const telegramWebAppUser = z.object({
  id: z.number().int(),
  first_name: z.string(),
  last_name: z.string().optional(),
  username: z.string().optional(),
  language_code: z.string().optional(),
  is_premium: z.boolean().optional(),
  is_bot: z.boolean().optional(),
  photo_url: z.string().url().optional(),
});
export type TelegramWebAppUser = z.infer<typeof telegramWebAppUser>;
