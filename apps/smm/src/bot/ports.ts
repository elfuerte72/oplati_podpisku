import type { DialogEvent, Keyboard, PipelineStep } from '../dialog/types.ts';

/**
 * Порты исполнителя: всё, что делает бот во внешнем мире. Автомат возвращает
 * эффекты данными, а сюда они превращаются в вызовы.
 *
 * Порты узкие и тотальные: тест подставляет фейк и сверяет вызовы, а прод
 * подставляет grammY и конвейер. Ошибки доставки логирует адаптер — в движке
 * нет ни одного `catch` по этому поводу.
 */
export type PreviewResult = { readonly ok: true } | { readonly ok: false; readonly message: string };

export interface BotPorts {
  /**
   * Сообщение владельцу. Возвращает id: по нему потом снимается клавиатура.
   * `html` — для свёрстанных сообщений (отчёт); вопросы бота идут текстом.
   */
  send(text: string, keyboard?: Keyboard, options?: { html?: boolean }): Promise<number | undefined>;
  editKeyboard(messageId: number, keyboard: Keyboard | null): Promise<void>;
  /** Ответ на нажатие. Telegram крутит часики, пока его не будет. */
  answerCallback(text?: string): Promise<void>;
  /**
   * Показать пост ровно так, как он уйдёт в канал. Result, а не `void`:
   * негодная разметка и пустое тело — обычный исход, и молчать о нём нельзя
   * (владелец иначе смотрит в «Собираю» и тишину).
   */
  preview(postId: string): Promise<PreviewResult>;
  /**
   * Запустить шаг конвейера. Возвращает СОБЫТИЕ для автомата: исход шага
   * выбирает следующий переход, а не сам шаг.
   */
  runStep(step: PipelineStep, args: Record<string, unknown>): Promise<DialogEvent | undefined>;
  schedulePublish(postId: string, at: string): void;
  cancelPublish(postId: string): void;
}
