import { z } from 'zod';

/**
 * Минимальный slice Telegram Update для milestone «Telegram webhook + AI v1».
 *
 * Покрывается ТОЛЬКО `message` с текстом — для `/start` и обычных текстовых
 * сообщений. `callback_query`, `edited_message`, `channel_post`, медиа —
 * пропущены до Sprint 2 (когда появятся inline keyboards и заказы).
 *
 * Сознательно не описываем все поля Telegram Update — мы валидируем границу,
 * не реплицируем `@types/telegram-bot-api`. Лишние поля Zod пропустит,
 * `passthrough()` нам не нужен (ничего не пробрасываем дальше).
 */

const telegramChatSchema = z.object({
  id: z.number().int(),
  type: z.string(),
});

const telegramUserSchema = z.object({
  id: z.number().int(),
  language_code: z.string().optional(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  is_bot: z.boolean().optional(),
});

const telegramMessageSchema = z.object({
  message_id: z.number().int(),
  chat: telegramChatSchema,
  from: telegramUserSchema.optional(),
  text: z.string().optional(),
});

/**
 * callback_query — приходит при нажатии inline-кнопки с `callback_data`.
 * `message` опциональный (если сообщение слишком старое — Telegram его не
 * приложит); `from` — обязательное (кто нажал).
 */
const telegramCallbackQuerySchema = z.object({
  id: z.string(),
  from: telegramUserSchema,
  message: telegramMessageSchema.optional(),
  chat_instance: z.string().optional(),
  data: z.string().optional(),
});

export const telegramUpdateSchema = z.object({
  update_id: z.number().int(),
  message: telegramMessageSchema.optional(),
  callback_query: telegramCallbackQuerySchema.optional(),
});

export type TelegramUpdate = z.infer<typeof telegramUpdateSchema>;
export type TelegramMessage = z.infer<typeof telegramMessageSchema>;
export type TelegramChat = z.infer<typeof telegramChatSchema>;
export type TelegramUser = z.infer<typeof telegramUserSchema>;
export type TelegramCallbackQuery = z.infer<typeof telegramCallbackQuerySchema>;
