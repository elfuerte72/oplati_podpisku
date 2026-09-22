import type { DialogEvent, Keyboard, PipelineStep } from '../dialog/types.ts';

/**
 * Порты исполнителя: всё, что делает бот во внешнем мире. Автомат возвращает
 * эффекты данными, а сюда они превращаются в вызовы.
 *
 * Порты узкие и тотальные: тест подставляет фейк и сверяет вызовы, а прод
 * подставляет grammY и конвейер. Ошибки доставки логирует адаптер — в движке
 * нет ни одного `catch` по этому поводу.
 */
export interface BotPorts {
  /** Сообщение владельцу. Возвращает id: по нему потом снимается клавиатура. */
  send(text: string, keyboard?: Keyboard): Promise<number | undefined>;
  editKeyboard(messageId: number, keyboard: Keyboard | null): Promise<void>;
  /** Ответ на нажатие. Telegram крутит часики, пока его не будет. */
  answerCallback(text?: string): Promise<void>;
  /** Показать пост ровно так, как он уйдёт в канал. */
  preview(postId: string): Promise<void>;
  /**
   * Запустить шаг конвейера. Возвращает СОБЫТИЕ для автомата: исход шага
   * выбирает следующий переход, а не сам шаг.
   */
  runStep(step: PipelineStep, args: Record<string, unknown>): Promise<DialogEvent | undefined>;
  schedulePublish(postId: string, at: string): void;
  cancelPublish(postId: string): void;
}
