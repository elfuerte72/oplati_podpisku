/**
 * L-22 (находка владельца на смоуке 2026-07-18): заметку «Карта уже есть —
 * платишь только за подписку» нельзя выводить из `cardIssueFeeKopecks === 0`.
 * Ноль в снимке надбавки бывает по ДВУМ причинам:
 *   1) у клиента реально есть активная карта (честный кейс повторной оплаты);
 *   2) `CARD_ISSUE_FEE_USD_CENTS` не задан/0 (dev/preview) — надбавка отключена
 *      для всех, карты у клиента НЕТ, и текст врал.
 * Показываем заметку только когда сходятся ОБА условия: надбавки нет И карта
 * фактически есть (из снапшота кабинета).
 */
export function showCardAlreadyOwnedNote(
  cardIssueFeeKopecks: number | null,
  hasActiveCard: boolean,
): boolean {
  return cardIssueFeeKopecks === 0 && hasActiveCard;
}
