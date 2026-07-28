import { describe, expect, it } from 'vitest';

import { amountWithBuyerFeeKopecks, buyerFeeAmountNote, buyerFeeNote } from './buyer-fee.ts';

const formatRub = (kopecks: number) => `${(kopecks / 100).toFixed(2)} ₽`;

describe('amountWithBuyerFeeKopecks', () => {
  it('0% — сумма не меняется (шлюз надбавку не берёт)', () => {
    expect(amountWithBuyerFeeKopecks(245_370, 0)).toBe(245_370);
  });

  it('6% СБП — оценка того, что клиент увидит на странице провайдера', () => {
    // 2453.70 ₽ × 1.06 = 2600.92 ₽. Точное округление на стороне провайдера нам
    // неизвестно, поэтому в UI цифра идёт со знаком «≈».
    expect(amountWithBuyerFeeKopecks(245_370, 6)).toBe(260_092);
  });

  it('отрицательный процент трактуется как отсутствие надбавки', () => {
    // Значение приходит из env/API: мусор не должен УМЕНЬШАТЬ показанную сумму —
    // это было бы обещание заплатить меньше, чем возьмут.
    expect(amountWithBuyerFeeKopecks(245_370, -5)).toBe(245_370);
  });
});

describe('buyerFeeNote', () => {
  it('0% → null: блок предупреждения не рендерится вовсе', () => {
    expect(buyerFeeNote(0)).toBeNull();
  });

  it('называет процент — коротко, без объяснений', () => {
    const note = buyerFeeNote(6);
    expect(note).toContain('6%');
    expect(note).toContain('комиссия платёжной системы');
  });

  it('дробный процент без хвостовых нулей', () => {
    expect(buyerFeeNote(6.5)).toContain('6.5%');
    expect(buyerFeeNote(7)).toContain('7%');
    expect(buyerFeeNote(7)).not.toContain('7.00%');
  });
});

describe('buyerFeeAmountNote', () => {
  it('0% → null', () => {
    expect(buyerFeeAmountNote(245_370, 0, formatRub)).toBeNull();
  });

  it('показывает итог со страницы оплаты, а не нашу сумму', () => {
    const note = buyerFeeAmountNote(245_370, 6, formatRub);
    expect(note).toContain('2600.92 ₽');
    // Наша сумма в этой строке появляться не должна: иначе рядом окажутся две
    // цифры без объяснения, какая из них к оплате.
    expect(note).not.toContain('2453.70 ₽');
    expect(note).toContain('6%');
  });
});
