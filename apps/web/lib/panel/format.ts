import type { CardStatus, PaymentStatus } from '@oplati/types';

/**
 * Форматирование для панели. Чистые функции без Next и без env — их зовут и
 * серверные страницы, и клиентские компоненты, и тесты.
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
function lookupLabel(dict: Record<string, string>, key: string): string | undefined {
  return Object.hasOwn(dict, key) ? dict[key] : undefined;
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
 * Человеческие подписи статусов заказа.
 *
 * Здесь `Record<string, …>` осознанно, в отличие от карт и платежей ниже:
 * подписи статусов заказа читает и клиентский кабинет со своим словарём, и
 * ссылка на общий тип связала бы две витрины, которые говорят с разной
 * аудиторией. Рантайм-фолбэк «показываем как есть» остаётся везде.
 */
const ORDER_STATUS_LABELS: Record<string, string> = {
  draft: 'черновик',
  clarifying: 'уточняем',
  kyc_required: 'нужен KYC',
  ready_for_payment: 'ждёт счёта',
  pending_payment: 'ждёт оплаты',
  payment_review: 'на проверке банка',
  paid: 'оплачен',
  in_fulfillment: 'в работе',
  completed: 'выполнен',
  failed: 'провалился',
  cancelled: 'отменён',
  expired: 'протух',
  refund_requested: 'запрошен возврат',
  refunded: 'возвращён',
};

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

/**
 * Статусы карты. Сырой `recycled` на экране менеджера не значит ничего:
 * «переработана» — это закрытая по сроку жизни карта, а не ошибка.
 *
 * ⚠️ `Record<CardStatus, …>`, а не `Record<string, …>`: новое значение enum'а
 * обязано СЛОМАТЬ сборку, а не молча показать менеджеру латиницу. Тот же приём,
 * что у прав в `permissions.ts` («новая роль не падает в менеджера»). Рантайм
 * при этом остаётся снисходительным — см. фолбэк ниже.
 */
const CARD_STATUS_LABELS: Record<CardStatus, string> = {
  active: 'активна',
  idle: 'простаивает',
  recycled: 'закрыта',
};

export function cardStatusLabel(status: string): string {
  return lookupLabel(CARD_STATUS_LABELS, status) ?? status;
}

/**
 * Статусы платежа. `pending` подписан «ждёт подтверждения», а НЕ «ждёт оплаты»:
 * при холде антифрода деньги у клиента уже списаны, а строка платежа остаётся
 * `pending` (claim не проходил). «Ждёт оплаты» на экране холдов означало бы
 * прямую ложь ровно в том случае, ради которого экран и заведён.
 */
const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  pending: 'ждёт подтверждения',
  succeeded: 'оплачен',
  failed: 'не прошёл',
  refunded: 'возвращён',
};

export function paymentStatusLabel(status: string): string {
  return lookupLabel(PAYMENT_STATUS_LABELS, status) ?? status;
}

/**
 * Код статуса платежа у провайдера. `7` — холд антифрода Freekassa
 * (эмпирический, подтверждён поддержкой 2026-08-14).
 *
 * ⚠️ Числа здесь литералами, хотя рядом есть `FREEKASSA_ORDER_STATUS`, и это
 * осознанный компромисс: `@oplati/types` тянет за собой zod, а модуль едет в
 * клиентский бандл (его читает `LocalTime`). Словарь ПОДПИСЕЙ — не источник
 * решений: решения (что считать холдом) принимаются на сервере из общей
 * константы, здесь только текст рядом с числом, которое всё равно печатается.
 */
const PROVIDER_STATUS_LABELS: Record<number, string> = {
  0: 'новый',
  1: 'оплачен',
  6: 'возврат',
  7: 'проверка банка',
  8: 'ошибка',
  9: 'отменён',
};

export function providerStatusLabel(code: number | null): string {
  if (code === null) return '—';
  const label = PROVIDER_STATUS_LABELS[code];
  return label ? `${code} — ${label}` : String(code);
}
