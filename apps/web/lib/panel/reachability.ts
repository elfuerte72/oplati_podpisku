/**
 * Достижим ли клиент в Telegram — общий помощник панели.
 *
 * Нужен трижды: карточка клиента (тикет 04), напоминание об оплате (07) и
 * ответ в поддержке (10). Один источник намеренно: три места, каждое со своим
 * «если telegramId не пустой», однажды разъедутся, и менеджер получит кнопку
 * ответа там, где отвечать некуда.
 *
 * На проде 47 клиентов из 103 без `telegram_id` — это не редкий случай, а почти
 * половина базы: человек оформил заказ на сайте и Telegram не привязал.
 * Написать ему нечем, и панель обязана говорить это прямо, а не рисовать
 * кнопку, которая молча ничего не сделает.
 */

import { CELL_TEXT } from './labels';

export type ClientReachability = {
  reachable: boolean;
  /** Текст для экрана, когда писать некуда. */
  reason: string | null;
};

export function clientReachability(client: {
  telegramId: string | null;
}): ClientReachability {
  if (client.telegramId && client.telegramId.trim().length > 0) {
    return { reachable: true, reason: null };
  }
  return {
    reachable: false,
    reason: CELL_TEXT.noTelegram,
  };
}

/** Короткая проверка для условий рендера. */
export function isReachableInTelegram(client: { telegramId: string | null }): boolean {
  return clientReachability(client).reachable;
}
