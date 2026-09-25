import {
  CARD_STATUS_LABELS,
  CELL_TEXT,
  ORDER_ACTOR_LABELS,
  ORDER_EVENT_LABELS,
  ORDER_STATUS_LABELS,
  PANEL_DISCOUNT_TEXT,
  PAYMENT_PROVIDER_LABELS,
  PAYMENT_STATUS_LABELS,
  PROVIDER_STATUS_LABELS,
} from './labels';

/**
 * Форматирование для панели. Чистые функции без Next и без env — их зовут и
 * серверные страницы, и клиентские компоненты, и тесты.
 *
 * Разделение с `labels.ts` простое: там — ЧТО написано, здесь — КАК посчитано
 * и оформлено. Тексты сюда приходят из словаря, своих копий нет.
 *
 * ⚠️ Деньги приходят целыми в минимальных единицах (инвариант 3) и такими же
 * считаются: `float` в рублях здесь не появляется даже на печать.
 *
 * ⚠️ Модуль едет в клиентский бандл: из чужих пакетов — только `type`-импорты,
 * из своих — только `labels.ts`, который держится того же правила.
 */

/**
 * Поиск подписи по словарю-литералу.
 *
 * Через `Object.hasOwn`, а не `dict[key]`: у объектного литерала есть прототип,
 * поэтому `dict['toString']` вернул бы ФУНКЦИЮ там, где тип обещает строку. Для
 * значений из enum'а базы это теория, а вот для кода ошибки из тела ответа —
 * нет: строка `toString` в поле `error` уронила бы React.
 */
export function lookupLabel(
  dict: Record<string, string>,
  key: string | undefined,
): string | undefined {
  return key !== undefined && Object.hasOwn(dict, key) ? dict[key] : undefined;
}

/** Копейки → «1 234 ₽». Дробную часть не показываем: копеек в ценах нет. */
export function formatKopecks(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const rubles = Math.round(value / 100);
  return `${rubles.toLocaleString('ru-RU')} ₽`;
}

/**
 * Приглушённая строка под ПОЛНОЙ ценой заказа в списках панели — «Все заказы»,
 * «Ждут оплаты», «Проверка платежей»: «счёт 2 295 ₽ · −405 ₽ промокод ·
 * −300 ₽ баллами». `null` — скидок нет, строка не нужна (заказ без скидок
 * выглядит как раньше).
 *
 * Одна функция на три экрана (тикет 05 аудита CRM): раньше каждый экран сам
 * печатал «−X баллами» и ни один не знал про промокод — оператор сверял
 * поступление шлюза с числом, которого у шлюза не было.
 *
 * `invoiceKopecks` — сумма РЕАЛЬНОГО счёта, когда выборка её знает (экран
 * проверки платежей: именно её называют поддержке шлюза). Нет — счёт выводится
 * как цена минус живые скидки: так же его считает `payments/create`.
 */
export function discountedInvoiceLine(row: {
  amountRubKopecks: number | null;
  bonusDiscountKopecks: number;
  promoDiscountKopecks: number;
  invoiceKopecks?: number | null | undefined;
}): string | null {
  const bonus = row.bonusDiscountKopecks;
  const promo = row.promoDiscountKopecks;
  if (bonus <= 0 && promo <= 0) return null;
  const invoice =
    row.invoiceKopecks ??
    (row.amountRubKopecks === null ? null : row.amountRubKopecks - promo - bonus);
  const parts = [`${PANEL_DISCOUNT_TEXT.invoiceShort} ${formatKopecks(invoice)}`];
  if (promo > 0) parts.push(`−${formatKopecks(promo)} ${PANEL_DISCOUNT_TEXT.promoShort}`);
  if (bonus > 0) parts.push(`−${formatKopecks(bonus)} ${CELL_TEXT.bonusPaid}`);
  return parts.join(' · ');
}

/**
 * «Запрошено у шлюза» на карточке заказа — сумма счёта (`payments.amount_rub`),
 * а не цена минус скидки на экране: число обязано совпадать с таблицей
 * платежей ниже и с тем, что видел шлюз. `null` — счетов не было, строки нет.
 *
 * Какой счёт: оплаченный, иначе живой, иначе последний любой. Последний пункт
 * нужен недоплате и протухшему счёту — платёж там `failed`, и именно на таком
 * заказе оператор сверяет, сколько просили и сколько пришло (ревью
 * 2026-09-25, ось E).
 */
export function invoicedPaymentKopecks(
  payments: readonly { status: string; amountRubKopecks: number; createdAt: Date }[],
): number | null {
  const rank = (status: string) => (status === 'succeeded' ? 2 : status === 'pending' ? 1 : 0);
  const best = payments.reduce<(typeof payments)[number] | null>((current, p) => {
    if (current === null) return p;
    const byRank = rank(p.status) - rank(current.status);
    if (byRank !== 0) return byRank > 0 ? p : current;
    return p.createdAt > current.createdAt ? p : current;
  }, null);
  return best?.amountRubKopecks ?? null;
}

/**
 * Разбивка чека: подписка + выпуск карты = итог.
 *
 * Считается В РУБЛЯХ от округлённых частей, а не округлением каждой строки
 * порознь: у легаси-заказов с копейками «подписка» и «выпуск» по отдельности
 * могли не сойтись с «итого» на рубль, и менеджер, сверяющий чек с клиентом,
 * видел бы арифметическую ошибку там, где её нет.
 *
 * Надбавка больше суммы — не «отрицательная подписка», а честная пометка:
 * такие данные означают порчу снимка, и молча показать минус хуже, чем сказать.
 */
export function priceBreakdown(
  amountKopecks: number | null,
  feeKopecks: number | null,
): { subscription: string; fee: string; total: string; note: string | null } {
  if (amountKopecks === null) {
    return { subscription: '—', fee: '—', total: '—', note: null };
  }

  const totalRub = Math.round(amountKopecks / 100);
  const feeRub = Math.round((feeKopecks ?? 0) / 100);

  if (feeRub > totalRub) {
    return {
      subscription: '—',
      fee: `${feeRub.toLocaleString('ru-RU')} ₽`,
      total: `${totalRub.toLocaleString('ru-RU')} ₽`,
      note: 'Надбавка за выпуск карты больше суммы заказа — снимок цены испорчен.',
    };
  }

  const subscriptionRub = totalRub - feeRub;
  return {
    subscription: `${subscriptionRub.toLocaleString('ru-RU')} ₽`,
    fee: feeRub > 0 ? `${feeRub.toLocaleString('ru-RU')} ₽` : '—',
    total: `${totalRub.toLocaleString('ru-RU')} ₽`,
    note: null,
  };
}

/**
 * Сумма в валюте сервиса. Валюта берётся ИЗ ЗАКАЗА, а не печатается знаком
 * доллара: у заказа в другой валюте `$15.00 EUR` было бы прямым враньём.
 */
export function formatOriginalAmount(
  amountMinor: number | null,
  currency: string | null,
): string {
  if (amountMinor === null) return '—';
  const value = (amountMinor / 100).toFixed(2);
  return currency ? `${value} ${currency}` : value;
}

/** USD-центы → «$12.34». Только там, где валюта заведомо доллары (карты). */
export function formatUsdCents(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `$${(value / 100).toFixed(2)}`;
}

/**
 * «3 ч 12 мин» — возраст записи. Считается ОТ переданного «сейчас», а не от
 * `Date.now()` внутри: иначе функция становится непроверяемой, а в панели
 * возраст показывается рядом с суммой и по нему принимают решения.
 */
export function formatAge(from: Date, now: Date): string {
  const ms = now.getTime() - from.getTime();
  if (ms < 0) return 'только что';

  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'только что';
  if (minutes < 60) return `${minutes} мин`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const restMinutes = minutes % 60;
    return restMinutes > 0 ? `${hours} ч ${restMinutes} мин` : `${hours} ч`;
  }

  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours > 0 ? `${days} д ${restHours} ч` : `${days} д`;
}

/**
 * Подпись статуса заказа. Словарь типизирован по enum'у (сборка ломается на
 * новом значении), а рантайм снисходителен: строка из базы может нести
 * значение, которого в типе уже нет, — показываем как есть, а не роняем экран.
 */
export function orderStatusLabel(status: string): string {
  return lookupLabel(ORDER_STATUS_LABELS, status) ?? status;
}

/**
 * Тон строки: им красится пилюля статуса. Имя типа отдельно от функции, потому
 * что по нему типизирован словарь классов (`class-names.ts`) — новый тон
 * обязан сломать сборку, а не остаться без цвета.
 */
export type PanelStatusTone = 'danger' | 'warn' | 'ok' | 'muted';

/**
 * Статусы, требующие внимания прямо сейчас, — для подсветки строки. Порядок
 * важности: деньги приняты, но заказ не доведён; банк держит; клиент не дожат.
 */
export function orderStatusTone(status: string): PanelStatusTone {
  if (status === 'failed') return 'danger';
  if (status === 'payment_review' || status === 'paid' || status === 'in_fulfillment') {
    return 'warn';
  }
  if (status === 'completed') return 'ok';
  if (status === 'pending_payment' || status === 'ready_for_payment') return 'warn';
  return 'muted';
}

export function cardStatusLabel(status: string): string {
  return lookupLabel(CARD_STATUS_LABELS, status) ?? status;
}

/**
 * Подпись события в истории заказа. Неизвестное значение показываем как есть:
 * событие могло появиться в коде раньше, чем строка в словаре, и прочерк вместо
 * него скрыл бы от менеджера, что с заказом вообще что-то происходило.
 */
export function orderEventLabel(eventType: string): string {
  return lookupLabel(ORDER_EVENT_LABELS, eventType) ?? eventType;
}

/** Кто сделал запись в истории заказа. */
export function orderActorLabel(actorType: string): string {
  return lookupLabel(ORDER_ACTOR_LABELS, actorType) ?? actorType;
}

/** Человеческое имя платёжного шлюза: в списке платежей стояло `loveandpay`. */
export function paymentProviderLabel(provider: string): string {
  return lookupLabel(PAYMENT_PROVIDER_LABELS, provider) ?? provider;
}

export function paymentStatusLabel(status: string): string {
  return lookupLabel(PAYMENT_STATUS_LABELS, status) ?? status;
}

/**
 * Статус платежа у Freekassa — «Расшифровка (код)». Код печатается всегда:
 * менеджер копирует его в обращение к провайдеру. Неизвестный код — числом,
 * а не прочерком.
 */
export function providerStatusLabel(code: number | null): string {
  if (code === null) return '—';
  // Код приходит из ответа провайдера: словарь типизирован по известным
  // значениям, а вход — любое число, поэтому читаем через `lookupLabel`.
  const label = lookupLabel(PROVIDER_STATUS_LABELS, String(code));
  return label ? `${label} (${code})` : String(code);
}

/** Целое число людей/заказов/кликов — «1 234». */
export function formatCount(value: number): string {
  return Math.trunc(value).toLocaleString('ru-RU');
}

/**
 * Доля 0..1+ → «50 %»; `null` — прочерк: конверсию к нулевому предыдущему шагу
 * считать нечем, и «0 %» там был бы ложью (нуля не было, было «не с чего»).
 */
export function formatShare(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${Math.round(value * 100).toLocaleString('ru-RU')} %`;
}
