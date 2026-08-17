import type { OrderStatus } from '@oplati/types';

/**
 * Напоминание об оплате (тикет 07) — правила, отделённые от Next и от БД.
 *
 * Зачем экран вообще есть: из 138 просроченных заказов **97 никогда не дошли до
 * счёта**, ещё 41 счёт получили и не оплатили. Это самая большая денежная
 * потеря на сегодня.
 *
 * ⚠️ Напоминание НИЧЕГО не создаёт: оно отправляет ссылку СУЩЕСТВУЮЩЕГО живого
 * счёта. Не выставляет новый, не продлевает старый, не двигает статус заказа.
 * Иначе кнопка в панели стала бы вторым способом создавать денежные документы —
 * мимо `payments/create` с его гейтами (контакты, потолок суммы, фиксация цены).
 *
 * ⚠️ Модуль зовут ДВОЕ — серверный экран и route-handler операции, — и правила
 * обязаны быть у них общими: кнопка, нарисованная по одному условию, и отказ по
 * другому означают, что менеджер жмёт и получает ошибку. Отсюда же требование к
 * содержимому: чистые функции, без zod, БД и env.
 */

/** Не чаще раза в сутки на заказ. Напоминание — не рассылка. */
export const PAYMENT_REMINDER_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * Почему кнопки нет. Причина показывается вместо кнопки: «кнопки просто нет» —
 * это загадка, из-за которой менеджер решит, что панель сломана.
 */
export type RemindBlockReason =
  | 'no_telegram'
  | 'no_invoice'
  | 'invoice_expired'
  | 'too_soon';

export const REMIND_BLOCK_TEXT: Record<RemindBlockReason, string> = {
  no_telegram: 'Нет Telegram — написать нечем. Клиент оформлял заказ на сайте.',
  // Два разных состояния и два разных совета. Черновик без счёта — самый
  // частый случай на этом экране (97 из 138 потерянных заказов), и «оформи
  // заказ заново» там неверно: клиенту достаточно нажать «Оплатить», а
  // пересоздание перефиксирует курс по новой ставке.
  no_invoice: 'Счёт не выставлялся: клиенту нужно нажать «Оплатить» в кабинете или на сайте.',
  invoice_expired:
    'Счёт протух. Напоминание отправляет ссылку существующего счёта и не создаёт новый — клиенту нужно оформить заказ заново.',
  too_soon: 'Напоминали меньше суток назад. Второе подряд читается как спам.',
};

export type RemindGateInput = {
  status: OrderStatus;
  hasTelegram: boolean;
  /** Есть ли у живого счёта ссылка на оплату (без неё отправлять нечего). */
  hasPaymentLink: boolean;
  /** Срок счёта. `null` — срок неизвестен, и это трактуется fail-closed. */
  invoiceExpiresAt: Date | null;
  /** Когда напоминали в последний раз (из `order_events`). */
  lastRemindedAt: Date | null;
  now: Date;
};

/**
 * `null` — напоминать можно. Иначе причина, почему нет.
 *
 * Порядок проверок — от «навсегда нельзя» к «нельзя сейчас»: менеджеру важнее
 * узнать, что клиенту вообще не написать, чем что счёт протух.
 *
 * ⚠️ Срок счёта проверяется ФАКТОМ, а не выводится из статуса заказа. Заказ
 * уходит из `pending_payment` кроном `expire-payments` раз в 15 минут, то есть
 * до четверти часа существует окно, где статус ещё оплатимый, а ссылка уже
 * мертва: клиент по ней получил бы страницу «счёт не найден».
 */
export function remindBlockReason(input: RemindGateInput): RemindBlockReason | null {
  if (!input.hasTelegram) return 'no_telegram';
  if (input.status !== 'pending_payment' || !input.hasPaymentLink) return 'no_invoice';
  // ⚠️ Пустой срок — это «не знаем», и трактуем его FAIL-CLOSED. Гейт заводился
  // против окна «статус ещё оплатимый, ссылка уже мертва»; пропустив
  // неизвестный срок, мы бы отправили клиенту ссылку, про которую сами ничего
  // не знаем. Сегодня оба шлюза срок пишут всегда — тем дешевле закрыться.
  if (!input.invoiceExpiresAt) return 'invoice_expired';
  if (input.invoiceExpiresAt.getTime() <= input.now.getTime()) return 'invoice_expired';
  if (
    input.lastRemindedAt &&
    input.now.getTime() - input.lastRemindedAt.getTime() < PAYMENT_REMINDER_COOLDOWN_MS
  ) {
    return 'too_soon';
  }
  return null;
}

/**
 * Строка недожатого заказа → вход гейта.
 *
 * Общая, потому что вход собирают ДВОЕ — экран (рисовать ли кнопку) и операция
 * (отправлять ли). Соберут по-разному — кнопка появится там, где операция
 * откажет, и ни один тест этого не заметит.
 */
export function remindGateInput(
  order: {
    status: OrderStatus;
    client: { telegramId: string | null };
    invoice: { paymentUrl: string | null; expiresAt: Date | null } | null;
    lastRemindedAt: Date | null;
  },
  now: Date,
): RemindGateInput {
  return {
    status: order.status,
    hasTelegram: Boolean(order.client.telegramId),
    hasPaymentLink: Boolean(order.invoice?.paymentUrl),
    invoiceExpiresAt: order.invoice?.expiresAt ?? null,
    lastRemindedAt: order.lastRemindedAt,
    now,
  };
}

/**
 * Текст клиенту. Простой текст, без HTML: внутри ссылка на оплату, и любая
 * разметка вокруг неё — лишний способ сломать её экранированием.
 *
 * Остаток срока считается В МИНУТАХ от переданного «сейчас», а не печатается
 * временем: часовой пояс клиента нам неизвестен, и «до 14:20» половине читателей
 * означало бы неверный час.
 */
export function buildPaymentReminderText(params: {
  shortId: string;
  amountRubKopecks: number | null;
  paymentUrl: string;
  expiresAt: Date | null;
  /**
   * Готовая строка про надбавку платёжной системы (`null` — надбавки нет).
   * Собирает её вызывающий: процент зависит от шлюза ЭТОГО счёта, а знание про
   * шлюзы серверное и в клиентский модуль не тянется.
   */
  feeNote?: string | null;
  now: Date;
}): string {
  const lines = [`Напоминаем про заказ ${params.shortId}: счёт выставлен и ждёт оплаты.`];

  if (params.amountRubKopecks !== null) {
    const rubles = Math.round(params.amountRubKopecks / 100);
    lines.push(`Сумма: ${rubles.toLocaleString('ru-RU')} ₽`);
  }

  // ⚠️ Надбавка платёжной системы называется РЯДОМ с суммой. Первое сообщение
  // со ссылкой её несёт, и напоминание без неё обещало бы цену ниже той, что
  // клиент увидит на странице оплаты.
  if (params.feeNote) lines.push(params.feeNote);

  lines.push('', params.paymentUrl);

  const minutesLeft = params.expiresAt
    ? Math.floor((params.expiresAt.getTime() - params.now.getTime()) / 60_000)
    : null;
  if (minutesLeft !== null && minutesLeft > 0) {
    lines.push('', `Ссылка действует ещё около ${minutesLeft} мин.`);
  }

  lines.push('', 'Если оплатить сейчас не получается — напиши /support, разберёмся.');
  return lines.join('\n');
}
