/**
 * Сверка телефона клиента с маскированным счётом плательщика из уведомления
 * Freekassa (антифрод-трек, тикет 07). Подтверждено: при СБП `payer_account` —
 * телефон плательщика; в хранилище он живёт только маской `****XXXX`.
 *
 * ⚠️ НИКАКИХ решений по результату (Р4): телефон СБП может законно отличаться
 * (карта родственника). Совпадение — позитивный сигнал, несовпадение —
 * нейтральная пометка для оператора в meta события `payment_succeeded`.
 *
 * ⚠️ При оплате КАРТОЙ `payer_account` — номер карты, и `false` здесь значит
 * «хвост PAN ≠ хвост телефона», то есть ничего: оператор читает пометку вместе
 * со способом оплаты платежа, сама сверка осмысленна только для СБП.
 */

/**
 * true — хвосты совпали; false — не совпали; null — данных для сверки нет
 * (нет маски, в маске меньше двух цифр, нет телефона в профиле).
 */
export function phoneTailMatches(
  masked: string | null | undefined,
  phone: string | null | undefined,
): boolean | null {
  if (!masked || !phone) return null;
  const maskedDigits = masked.replace(/\D/g, '');
  const phoneDigits = phone.replace(/\D/g, '');
  // По одной цифре сверять бессмысленно — совпадение случайно в 1 из 10.
  if (maskedDigits.length < 2 || phoneDigits.length < maskedDigits.length) return null;
  return phoneDigits.endsWith(maskedDigits);
}
