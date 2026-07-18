import { describe, expect, it } from 'vitest';

import { showCardAlreadyOwnedNote } from './card-fee-note.ts';

describe('showCardAlreadyOwnedNote (L-22: «карта уже есть» — по факту карты, не по fee=0)', () => {
  it('fee=0 И активная карта есть → показываем (честный кейс повторной оплаты)', () => {
    expect(showCardAlreadyOwnedNote(0, true)).toBe(true);
  });

  it('fee=0 БЕЗ карты (env-надбавка отключена, dev/preview) → НЕ показываем', () => {
    // Находка владельца на смоуке 2026-07-18: на dev CARD_ISSUE_FEE_USD_CENTS
    // не задан → fee=0 у всех, и UI врал «карта уже есть» первому же клиенту.
    expect(showCardAlreadyOwnedNote(0, false)).toBe(false);
  });

  it('fee>0 → не показываем независимо от карты (идёт строка «Выпуск карты»)', () => {
    expect(showCardAlreadyOwnedNote(40000, true)).toBe(false);
    expect(showCardAlreadyOwnedNote(40000, false)).toBe(false);
  });

  it('fee=null (заказ до фичи) → не показываем', () => {
    expect(showCardAlreadyOwnedNote(null, true)).toBe(false);
  });
});
