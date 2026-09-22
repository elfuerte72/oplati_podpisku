import { InputFile, type Api } from 'grammy';

import type { Outgoing, RenderKeyboard } from './render.ts';

/**
 * Отправка поста. ОДНА функция и для превью, и для канала: разойдись они,
 * владелец утверждал бы одно, а в канал уходило другое — и увидел бы это уже
 * после публикации.
 *
 * Клиент Bot API прячется за узким портом `SendApi`: тесты подставляют фейк и
 * сверяют вызовы, а адаптер `grammyApi` доказывает на этапе компиляции, что
 * вызовы совпадают с настоящими методами grammY.
 */

export interface SendTarget {
  readonly chatId: string | number;
  /** Тема форума: превью уходит в «Черновики» группы SMM. */
  readonly threadId?: number;
}

export interface OutgoingFile {
  readonly path: string;
}

export interface RichPayload {
  readonly markdown: string;
  readonly media?: readonly { readonly id: string; readonly file: OutgoingFile }[];
}

export interface SendOptions {
  readonly threadId?: number;
  readonly keyboard?: RenderKeyboard;
}

export interface SendApi {
  sendRichMessage(
    chatId: string | number,
    rich: RichPayload,
    options: SendOptions,
  ): Promise<{ readonly message_id: number }>;
  sendPhoto(
    chatId: string | number,
    photo: OutgoingFile,
    options: SendOptions & { caption: string },
  ): Promise<{ readonly message_id: number }>;
  sendMessage(
    chatId: string | number,
    text: string,
    options: SendOptions,
  ): Promise<{ readonly message_id: number }>;
}

export type SendResult =
  | { readonly ok: true; readonly messageId: number }
  | { readonly ok: false; readonly message: string; readonly code?: number };

function toReplyMarkup(keyboard?: RenderKeyboard) {
  if (keyboard === undefined) return undefined;
  return {
    inline_keyboard: keyboard.rows.map((row) => row.map((button) => ({ text: button.text, url: button.url }))),
  };
}

/** Адаптер настоящего клиента grammY к узкому порту. */
export function grammyApi(api: Api): SendApi {
  return {
    async sendRichMessage(chatId, rich, options) {
      const message = await api.sendRichMessage(
        chatId,
        {
          markdown: rich.markdown,
          ...(rich.media === undefined || rich.media.length === 0
            ? {}
            : {
                media: rich.media.map((item) => ({
                  id: item.id,
                  media: { type: 'photo' as const, media: new InputFile(item.file.path) },
                })),
              }),
        },
        {
          ...(options.threadId === undefined ? {} : { message_thread_id: options.threadId }),
          ...(toReplyMarkup(options.keyboard) === undefined
            ? {}
            : { reply_markup: toReplyMarkup(options.keyboard) }),
        },
      );
      return { message_id: message.message_id };
    },
    async sendPhoto(chatId, photo, options) {
      const message = await api.sendPhoto(chatId, new InputFile(photo.path), {
        caption: options.caption,
        parse_mode: 'HTML',
        ...(options.threadId === undefined ? {} : { message_thread_id: options.threadId }),
        ...(toReplyMarkup(options.keyboard) === undefined
          ? {}
          : { reply_markup: toReplyMarkup(options.keyboard) }),
      });
      return { message_id: message.message_id };
    },
    async sendMessage(chatId, text, options) {
      const message = await api.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...(options.threadId === undefined ? {} : { message_thread_id: options.threadId }),
        ...(toReplyMarkup(options.keyboard) === undefined
          ? {}
          : { reply_markup: toReplyMarkup(options.keyboard) }),
      });
      return { message_id: message.message_id };
    },
  };
}

export async function sendPost(
  api: SendApi,
  target: SendTarget,
  outgoing: Outgoing,
): Promise<SendResult> {
  const options: SendOptions = {
    ...(target.threadId === undefined ? {} : { threadId: target.threadId }),
    keyboard: outgoing.keyboard,
  };
  try {
    if (outgoing.kind === 'rich') {
      const message = await api.sendRichMessage(
        target.chatId,
        {
          markdown: outgoing.markdown,
          media: outgoing.media.map((item) => ({ id: item.id, file: { path: item.path } })),
        },
        options,
      );
      return { ok: true, messageId: message.message_id };
    }
    if (outgoing.photoPath !== undefined) {
      const message = await api.sendPhoto(
        target.chatId,
        { path: outgoing.photoPath },
        { ...options, caption: outgoing.text },
      );
      return { ok: true, messageId: message.message_id };
    }
    const message = await api.sendMessage(target.chatId, outgoing.text, options);
    return { ok: true, messageId: message.message_id };
  } catch (error) {
    // Отказ Bot API — это Result: пост жив, владелец получит причину. Код
    // ошибки нужен вызывающему: 403 «бот заблокирован» и 400 «негодная
    // разметка» требуют разных действий.
    const code = (error as { error_code?: number }).error_code;
    const description = (error as { description?: string }).description;
    return {
      ok: false,
      message: description ?? (error instanceof Error ? error.message : String(error)),
      ...(code === undefined ? {} : { code }),
    };
  }
}
