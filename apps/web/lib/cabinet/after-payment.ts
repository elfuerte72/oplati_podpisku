/**
 * Что делает Mini App после того, как клиент ушёл на страницу оплаты (трек
 * miniapp-tabs, тикет 08).
 *
 * Счёт открывается во внешнем браузере, и вернувшийся в Telegram клиент видел
 * «Ждёт оплаты», пока сам не уходил с экрана (находка П9 разбора пути). Теперь
 * лист заказа опрашивает действие `order`, а при смене статуса приложение само
 * ведёт на вкладку «Карта».
 *
 * Опрашивается именно `order`, а не `snapshot`: снапшот ходит в PaySpace за
 * живым балансом карты (`lib/cabinet/live-balance.ts`), `order` — только в БД.
 */

/** Шаг опроса. 12 запросов в минуту из 30 бакета `cabinet` — запас под остальное. */
export const POLL_INTERVAL_MS = 5_000;

/** Потолок опроса от ухода на оплату: дальше клиент вернётся сам. */
export const POLL_MAX_MS = 10 * 60 * 1000;

/**
 * Чей заказ опрашивать. Только того, чей лист открыт сейчас: клиент мог
 * закрыть лист (или открыть другой заказ), пока готовился счёт, — тогда ответы
 * по прежнему заказу выбрасывались бы до потолка, а лимит бы тратился.
 */
export function pollTargetOrderId(
  awaiting: { orderId: string } | null,
  openOrderId: string | null,
): string | null {
  return awaiting !== null && awaiting.orderId === openOrderId ? awaiting.orderId : null;
}

/**
 * Шаг опроса после 429. Бакет `cabinet` общий на все действия клиента, и опрос,
 * долбящий тем же шагом, выедал бы его: «Оплатить» или «Реквизиты карты»
 * получали бы отказ из-за фонового чтения.
 */
export const RATE_LIMITED_BACKOFF_MS = 30_000;

/** Через сколько после ответа ждать следующий опрос; код ошибки — прошлого ответа. */
export function nextPollDelayMs(lastError: string | null): number {
  return lastError === 'rate_limited' ? RATE_LIMITED_BACKOFF_MS : POLL_INTERVAL_MS;
}

/**
 * Возврат в приложение приходит двумя событиями сразу — `visibilitychange` и
 * `activated` Telegram. Каждый возврат перечитывает снапшот, а тот ходит в
 * PaySpace за живым балансом: второй вызов в том же окне — лишний.
 */
export const APP_RETURN_DEDUP_MS = 2_000;

export function isDuplicateReturn(lastReturnAt: number | null, now: number): boolean {
  return lastReturnAt !== null && now - lastReturnAt < APP_RETURN_DEDUP_MS;
}

/**
 * Сколько приложение может пробыть свёрнутым с открытыми реквизитами, прежде
 * чем они спрячутся (находка ревью). Короткий уход — скопировать номер и
 * вставить на сайте сервиса — реквизиты не трогает: иначе за CVC пришлось бы
 * открывать лист заново. Долгий — прячет: PAN и CVC не должны висеть на экране
 * и в снимке переключателя приложений бессрочно.
 */
export const REVEAL_BACKGROUND_LIMIT_MS = 5 * 60 * 1000;

export function revealExpiredAfterBackground(hiddenAt: number | null, now: number): boolean {
  return hiddenAt !== null && now - hiddenAt > REVEAL_BACKGROUND_LIMIT_MS;
}

/** Статусы, в которых карта ещё в пути: деньги пришли, выдачи не было. */
const ISSUING_STATUSES = new Set(['paid', 'in_fulfillment']);

/**
 * Опрашивать ли заказ, ожидая подтверждения оплаты: только пока счёт выставлен
 * (`pending_payment`), только при видимом приложении и не дольше потолка. Смена
 * статуса — сама по себе ответ, дальше решает `afterPaymentOutcome`.
 */
export function shouldPoll(status: string, elapsedMs: number, visible: boolean): boolean {
  return status === 'pending_payment' && visible && elapsedMs < POLL_MAX_MS;
}

/**
 * Следить ли за выпуском карты после оплаты: вкладка «Карта» показывает
 * «Выпускаю карту…», и без слежки клиент застрял бы на ней до перезахода, хотя
 * карта уже готова. Тот же шаг и потолок, что у опроса оплаты.
 */
export function shouldWatchIssuing(status: string, elapsedMs: number, visible: boolean): boolean {
  return ISSUING_STATUSES.has(status) && visible && elapsedMs < POLL_MAX_MS;
}

/**
 * Куда ведёт новый статус заказа, пока открыт лист оплаты:
 *  - `to_card` — деньги пришли (выпуск или уже выдана): закрыть лист, «Карта»;
 *  - `stay` — остаёмся на листе. Сюда же `payment_review`: банк держит платёж,
 *    и лист честно показывает «Платёж на проверке банка», а не уводит на карту,
 *    которой может и не быть.
 */
export function afterPaymentOutcome(status: string): 'to_card' | 'stay' {
  return ISSUING_STATUSES.has(status) || status === 'completed' ? 'to_card' : 'stay';
}
