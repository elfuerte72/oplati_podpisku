/**
 * Конвертеры на границе app.pay.space.
 *
 * PaySpace оперирует суммами то строкой ("18.43"), то числом (1.0 — `card.balance`
 * в create), а наш внутренний инвариант — деньги integer в минимальных единицах
 * (USD-центы). Перевод — только здесь.
 */
import { createHash } from 'node:crypto';

/**
 * Короткий детерминированный `request_id` для операций PaySpace (topup/release).
 *
 * ВАЖНО (живой вызов 2026-06-26): PaySpace МОЛЧА отклоняет операцию
 * (`success:true, status:'failed'`) при слишком длинном `request_id`.
 * Прод-формат `topup_<uuid-заказа>_<uuid-карты>` (79 символов) падал на каждом
 * заказе → реюз карт не срабатывал ни разу, фолбэк плодил новые карты ($4/шт.).
 * Тот же вызов с коротким id (28 символов) проходит (`completed`). Точный лимит
 * в доке не указан; берём заведомо короткий ключ. См. docs/known-issues.
 *
 * Хэшируем входные части в 16 hex-символов: детерминированно (повтор того же
 * fulfillment → тот же ключ, идемпотентность провайдера), коллизионно-устойчиво,
 * и коротко (`<prefix>_<16hex>` ≤ ~20 символов).
 */
export function paySpaceRequestId(prefix: string, ...parts: string[]): string {
  const hash = createHash('sha256').update(parts.join(':')).digest('hex').slice(0, 16);
  return `${prefix}_${hash}`;
}

/** USD-центы (integer) → строка-доллары "X.XX" (без потери точности на fp). */
export function usdCentsToDollarString(cents: number): string {
  if (!Number.isInteger(cents)) {
    throw new Error(`usdCentsToDollarString: ожидался integer, получено ${cents}`);
  }
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  return `${sign}${whole}.${String(frac).padStart(2, '0')}`;
}

/**
 * Сумма из ответа PaySpace (строка "10.5" или число 1.0) → USD-центы (integer).
 *
 * Парсим через строку, а не `Number(value) * 100`: умножение на 100 в плавающей
 * точке на «грязных» суммах (например 3+ знака после точки) может разойтись с
 * фактическим балансом карты на цент. Берём ровно 2 знака центов + 1 знак для
 * округления к ближайшему. Для штатных 2-знаковых сумм результат идентичен прежнему.
 */
export function dollarStringToUsdCents(value: string | number): number {
  const str = (typeof value === 'number' ? value.toString() : value).trim();
  if (!/^-?\d+(\.\d+)?$/.test(str)) {
    throw new Error(`dollarStringToUsdCents: невалидная сумма "${value}"`);
  }
  const negative = str.startsWith('-');
  const [wholePart, fracPart = ''] = str.replace(/^-/, '').split('.');
  // Добиваем дробную часть нулями до 3 знаков: 2 на центы + 1 на округление.
  const padded = `${fracPart}000`.slice(0, 3);
  const centsFromFrac = Number(padded.slice(0, 2));
  const roundUp = Number(padded[2]) >= 5 ? 1 : 0;
  const cents = Number(wholePart) * 100 + centsFromFrac + roundUp;
  return negative ? -cents : cents;
}

/**
 * Сумма фондирования карты = цена сервиса + буфер (округление ВВЕРХ, `Math.ceil`).
 *
 * Буфер — операционный запас под местный VAT/НДС по стране карты, FX-конвертацию
 * платёжной сети и foreign-transaction-fee: реальный charge иностранной подписки
 * часто выше витринной USD-цены (наблюдалось: эстонская карта $100 → списание
 * ~$114). Без запаса карта на ровную цену получает «недостаточно средств» при
 * первой же оплате с НДС. Закладывается ТОЛЬКО в сумму карты — цена для клиента
 * (она же `originalAmount`) не меняется; остаток вернётся на VCC-баланс при release.
 */
export function cardFundingUsdCents(priceUsdCents: number, bufferPercent: number): number {
  if (!Number.isInteger(priceUsdCents) || priceUsdCents < 0) {
    throw new Error(
      `cardFundingUsdCents: цена должна быть неотрицательным integer, получено ${priceUsdCents}`,
    );
  }
  if (!Number.isFinite(bufferPercent) || bufferPercent < 0) {
    throw new Error(`cardFundingUsdCents: буфер должен быть >= 0, получено ${bufferPercent}`);
  }
  return Math.ceil(priceUsdCents * (1 + bufferPercent / 100));
}

/**
 * Маска PAN для БД/логов: первые 6 + последние 4, середина — звёздочки.
 * Полный PAN провайдер маской не отдаёт — считаем сами. Короткие/нечисловые
 * значения маскируем целиком, чтобы не утечь PAN.
 */
export function maskPan(pan: string): string {
  const digits = pan.replace(/\D/g, '');
  if (digits.length < 10) return '*'.repeat(Math.max(digits.length, 4));
  return `${digits.slice(0, 6)}${'*'.repeat(digits.length - 10)}${digits.slice(-4)}`;
}

/**
 * Срок действия карты → { expMonth, expYear }. Поддерживает оба формата, что
 * встречаются у PaySpace: `MM/YY` (реальный ответ create/info) и `YYYY-MM-DD`
 * (как в доке). Зафиксировано живым вызовом 2026-06-18: create вернул "06/27".
 */
export function parseExpDate(value: string): { expMonth: number; expYear: number } {
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (ymd) {
    const yyyy = ymd[1];
    const mm = ymd[2];
    if (yyyy && mm) return { expYear: Number(yyyy), expMonth: Number(mm) };
  }
  const my = /^(\d{2})\/(\d{2})$/.exec(value);
  if (my) {
    const mm = my[1];
    const yy = my[2];
    if (mm && yy) return { expMonth: Number(mm), expYear: 2000 + Number(yy) };
  }
  throw new Error(`parseExpDate: неизвестный формат срока "${value}"`);
}
