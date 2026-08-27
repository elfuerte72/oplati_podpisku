import {
  CARD_STATUS_LABELS,
  ORDER_STATUS_LABELS,
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
 * ⚠️ Импорты — только `type`: модуль едет в клиентский бандл.
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
 * Статусы, требующие внимания прямо сейчас, — для подсветки строки. Порядок
 * важности: деньги приняты, но заказ не доведён; банк держит; клиент не дожат.
 */
export function orderStatusTone(status: string): 'danger' | 'warn' | 'ok' | 'muted' {
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
