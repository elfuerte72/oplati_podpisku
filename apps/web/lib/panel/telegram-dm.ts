/**
 * Личная переписка с клиентом из панели — один источник правды о том, можно ли
 * ему написать и по какому адресу.
 *
 * ⚠️ Главный факт, из которого всё следует: **написать клиенту в Telegram можно
 * только по его @username**. Числовой `telegram_id` для этого не годится —
 * ссылки вида `tg://user?id=<id>` требуют `access_hash`, который есть лишь у
 * того, кто с этим человеком уже переписывался; у персонала его нет, и такая
 * ссылка молча открывает пустоту. Поэтому клиент без username личкой
 * недостижим, и панель обязана сказать это прямо, а не рисовать кнопку,
 * которая ничего не делает (то же правило, что в `reachability.ts`).
 *
 * Второй путь связи — ответ через бота из раздела «Поддержка» — работает
 * ВСЕГДА, пока у клиента есть `telegram_id`, и именно его мы предлагаем, когда
 * личка недоступна.
 */

/**
 * Допустимый @username: латиница, цифры и `_`, 4–32 символа (Telegram выдаёт
 * 5–32, но у ранних аккаунтов встречаются четырёхбуквенные).
 *
 * Проверка обязательна, а не «для порядка»: значение приходит из внешнего
 * источника и подставляется в `href`. Символ `/`, `?` или `#` внутри увёл бы
 * ссылку на чужой адрес прямо из карточки клиента.
 */
const USERNAME_RE = /^[A-Za-z0-9_]{4,32}$/;

export type ClientDirectMessage =
  | { available: true; url: string; handle: string }
  | { available: false; reason: 'no_telegram' | 'no_username' };

/**
 * Ссылка на личную переписку с клиентом.
 *
 * `no_telegram` — клиент оформил заказ на сайте и Telegram не привязал: писать
 * нечем вообще. `no_username` — Telegram есть, но публичного имени нет: пишем
 * через бота.
 */
export function clientDirectMessage(client: {
  telegramId: string | null;
  telegramUsername: string | null;
}): ClientDirectMessage {
  if (!client.telegramId || client.telegramId.trim().length === 0) {
    return { available: false, reason: 'no_telegram' };
  }
  const handle = normalizeUsername(client.telegramUsername);
  if (!handle) return { available: false, reason: 'no_username' };
  return { available: true, url: `https://t.me/${handle}`, handle: `@${handle}` };
}

/**
 * Приводит username к каноничному виду: снимает ведущую `@` и пробелы.
 * Возвращает `null` для всего, что не похоже на username Telegram, — мусор из
 * базы не должен доехать до `href`.
 */
export function normalizeUsername(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/^@/, '');
  return USERNAME_RE.test(trimmed) ? trimmed : null;
}
