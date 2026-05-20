import { z } from 'zod';

/**
 * Минимальный slice Telegram Update.
 *
 * Покрывается `message` (текст + опциональные медиа-поля для P0-1) и
 * `callback_query` (для inline-кнопок). Медиа-поля валидируем как `unknown` —
 * нам важно только их наличие, чтобы ответить шаблоном; разбирать структуру
 * (file_id и пр.) пока не нужно.
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
  caption: z.string().optional(),
  // Медиа-поля: парсим только наличие. Структуру (file_id, mime_type и т.п.)
  // не разбираем — нам нужно лишь определить тип контента для шаблонного ответа.
  photo: z.array(z.unknown()).optional(),
  voice: z.unknown().optional(),
  video_note: z.unknown().optional(),
  audio: z.unknown().optional(),
  document: z.unknown().optional(),
  sticker: z.unknown().optional(),
  animation: z.unknown().optional(),
  video: z.unknown().optional(),
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
