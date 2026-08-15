/**
 * Нормализация телефона плательщика (антифрод-трек, тикет 05) — ОБЩАЯ для
 * клиента (плашка контактов, экран профиля) и сервера (роуты, гейт
 * `phone_required`), поэтому без `server-only`.
 *
 * Цель — E.164 (`+79991234567`). RU-приоритет: основная аудитория платит по
 * СБП с российских номеров, но клиент может жить не в РФ — любой валидный
 * `+<код><номер>` принимается (Р4/спека §4.2: сверка с payer_account —
 * позитивный сигнал, не фильтр).
 */

/** Код ошибки «нужен телефон» — единственный источник литерала. */
export const PHONE_REQUIRED = 'phone_required';

/** Текст невалидного номера — общий для роутов и подсказки в плашке. */
export const PHONE_INVALID_TEXT = 'Номер выглядит некорректно — проверь телефон.';

/** Текст отказа гейта; порог подставляется динамически (инвариант 10 — не зашивать). */
export function phoneRequiredText(thresholdRub: number): string {
  return `Для заказов от ${thresholdRub.toLocaleString('ru-RU')} ₽ банк требует телефон плательщика — укажи его в контактах заказа.`;
}

/** Подпись у поля телефона в плашке — тоже с динамическим порогом. */
export function phoneFieldHint(thresholdRub: number): string {
  return `Для заказов от ${thresholdRub.toLocaleString('ru-RU')} ₽ банк требует телефон плательщика.`;
}

/** Текст отказа, когда порог до клиента не доехал (fallback без цифры). */
export const PHONE_REQUIRED_FALLBACK_TEXT =
  'Банк требует телефон плательщика для этой суммы — укажи его в контактах заказа.';

/**
 * Нужен ли телефон для суммы заказа. ЕДИНСТВЕННОЕ место конверсии порога
 * (целые рубли из env/конфига) в копейки (`orders.amount_rub`, инвариант 3):
 * авторитетный гейт `payments/create` и обе плашки (сайт, Mini App) обязаны
 * звать эту функцию — иначе порог разъедется молча (инвариант 10).
 */
export function isPhoneRequiredForAmount(
  amountKopecks: number | null,
  thresholdRub: number | null,
): boolean {
  return thresholdRub !== null && amountKopecks !== null && amountKopecks >= thresholdRub * 100;
}

/**
 * Приводит ввод к E.164 или отдаёт null.
 *
 * Правила:
 *  - `+<7-15 цифр>` — принимаем (E.164), разделители/скобки игнорируем;
 *  - `8XXXXXXXXXX` (11 цифр, ведущая 8) — российская запись → `+7XXXXXXXXXX`;
 *  - `7XXXXXXXXXX` (11 цифр, ведущая 7) → `+7XXXXXXXXXX`;
 *  - `9XXXXXXXXX` (10 цифр, ведущая 9) — мобильный без кода → `+79XXXXXXXXX`;
 *  - остальное без `+` не угадываем: чужая страна без кода — это уже не номер,
 *    а лотерея, и в поле, которое уходит провайдеру, лотерее не место.
 */
/**
 * Номер из Telegram-контакта (`contact.phone_number`): Telegram отдаёт его С
 * кодом страны, но иногда БЕЗ `+` — «дописать плюс» здесь безопасно, в отличие
 * от ручного ввода, где страну без кода мы не угадываем.
 */
export function normalizeTelegramPhone(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return normalizePhone(trimmed.startsWith('+') ? trimmed : `+${trimmed}`);
}

export function normalizePhone(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');

  if (hasPlus) {
    if (digits.length < 7 || digits.length > 15) return null;
    return `+${digits}`;
  }
  if (digits.length === 11 && (digits.startsWith('8') || digits.startsWith('7'))) {
    return `+7${digits.slice(1)}`;
  }
  if (digits.length === 10 && digits.startsWith('9')) {
    return `+7${digits}`;
  }
  return null;
}
