import 'server-only';

import { serverEnv } from '../env.server.ts';

import { formatOpsMessage, type OpsAction } from './format.ts';
import { type AlertStream, notifyStream } from './streams.ts';

/**
 * Прямой ops-алерт в Telegram для сбоев, которые НЕЛЬЗЯ пропустить
 * (оплаченный заказ не доехал до клиента, деньги приняты без заказа).
 *
 * Тонкая обёртка над `notifyStream` (`streams.ts`): вызывающий называет ПОТОК —
 * тему ops-группы, куда ляжет сообщение. При заданной группе шлёт бот входа в
 * тему потока; при незаданной — прежняя личка `ALERT_TELEGRAM_CHAT_ID` через
 * alert-бота (режим dev и страховка отката).
 *
 * НЕ зависит от Sentry alert rules / вебхуков — отдельный, прямой канал: даже
 * если Sentry-маршрутизация не настроена, владелец узнает о провале сразу.
 * Анти-петля: ошибку доставки только логируем (НЕ `Sentry.captureException`),
 * иначе провал алерта породил бы новый Sentry-issue → снова алерт.
 *
 * Возвращает, СОСТОЯЛАСЬ ли доставка. Никогда не бросает — вызывающему это
 * нужно не для обработки ошибки, а чтобы не выдавать несостоявшуюся отправку
 * за состоявшуюся (например, занимая ею окно дедупа на час вперёд).
 */
export async function notifyOps(text: string, opts: NotifyOpsOptions): Promise<boolean> {
  const composed = formatOpsMessage(
    { title: opts.title, body: text, action: opts.action },
    serverEnv.PANEL_HOST,
  );
  return notifyStream(opts.stream, composed);
}

export type NotifyOpsOptions = {
  /**
   * Поток (тема группы) — ОБЯЗАТЕЛЕН: вызов без потока не компилируется, и
   * «забыл разметить» ловит typecheck, а не владелец, разбирающий корень
   * группы. Таблица «событие → поток» — спека трека ops-group и
   * `docs/runbooks/monitoring.md`.
   */
  stream: AlertStream;
  /** Заголовок события — первая строка сообщения (`formatOpsMessage`). */
  title?: string;
  /** «Что делать» — последняя строка, с ссылкой на экран панели, где он есть. */
  action?: OpsAction;
};
