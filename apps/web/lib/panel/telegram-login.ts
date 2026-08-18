import { createHash, createHmac } from 'node:crypto';

import { z } from 'zod';

import { timingSafeEqualStr } from '@/lib/security/timing-safe';

/**
 * Проверка подписи Telegram Login Widget — первый фактор входа в панель.
 *
 * Контракт Telegram (подтверждён их документацией и воспроизведён в тестах
 * побайтово):
 *   data_check_string = все переданные поля КРОМЕ `hash`, отсортированные по
 *                       имени, в виде `key=value`, склеенные через `\n`;
 *   secret_key        = SHA256(<токен бота>);
 *   hash              = HMAC_SHA256(data_check_string, secret_key), hex.
 *
 * ⚠️ В подписи участвуют ВСЕ пришедшие поля, а не только те, что нам интересны:
 * Telegram добавляет `photo_url`/`last_name` не всегда, и «подписываем только
 * известные» означало бы отказ живому сотруднику с аватаркой. Обратная сторона
 * — приписать своё поле к чужому payload'у нельзя: подпись сломается.
 *
 * Бот входа — ОТДЕЛЬНЫЙ от клиентского (`@oplatishkaasupport_bot`): утечка
 * клиентского токена не должна отдавать первый фактор входа персонала.
 */

/**
 * Сколько живёт подписанный виджетом вход. Минуты, не часы: payload виден в
 * адресной строке и в истории браузера, и его повторное применение обязано
 * упираться в срок. Пяти минут хватает на «нажал кнопку — ввёл код».
 */
export const LOGIN_WIDGET_MAX_AGE_SECONDS = 300;

const loginWidgetSchema = z
  .object({
    id: z.string().regex(/^\d+$/),
    first_name: z.string().min(1),
    last_name: z.string().optional(),
    username: z.string().optional(),
    photo_url: z.string().optional(),
    auth_date: z.string().regex(/^\d+$/),
    hash: z.string().min(1),
  })
  // Нестрогая: неизвестные поля Telegram сохраняем — они участвуют в подписи.
  .passthrough();

export type LoginWidgetResult =
  | {
      ok: true;
      telegramId: string;
      displayName: string;
      /** Подпись payload'а — ключ одноразовости (защита от переигровки). */
      signature: string;
    }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' | 'not_configured' };

export function verifyLoginWidgetPayload(
  raw: unknown,
  botToken: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): LoginWidgetResult {
  if (!botToken) return { ok: false, reason: 'not_configured' };

  const parsed = loginWidgetSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'malformed' };

  const { hash, ...fields } = parsed.data;

  const dataCheckString = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${String(fields[key])}`)
    .join('\n');

  const secretKey = createHash('sha256').update(botToken).digest();
  const expected = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  // Сравнение — общим `timingSafeEqualStr` (сверка SHA-256 дайджестов), а НЕ
  // `timingSafeEqual` над буферами подписей: своя проверка «длины совпадают»
  // считала бы СИМВОЛЫ, а `timingSafeEqual` меряет БАЙТЫ — один многобайтовый
  // символ в присланном `hash` давал бы RangeError наружу, то есть 500 вместо
  // отказа, да ещё и мимо счётчика неудачных попыток входа.
  if (!timingSafeEqualStr(expected, hash)) return { ok: false, reason: 'bad_signature' };

  // Свежесть — ПОСЛЕ подписи: `auth_date` без проверенной подписи ничего не
  // значит, и отвечать по нему «просрочено» значило бы отвечать на подделку.
  const authDate = Number(parsed.data.auth_date);
  const age = nowSeconds - authDate;
  if (age > LOGIN_WIDGET_MAX_AGE_SECONDS || age < -LOGIN_WIDGET_MAX_AGE_SECONDS) {
    return { ok: false, reason: 'expired' };
  }

  const displayName = [parsed.data.first_name, parsed.data.last_name]
    .filter((part): part is string => Boolean(part))
    .join(' ');

  return { ok: true, telegramId: parsed.data.id, displayName, signature: hash };
}
