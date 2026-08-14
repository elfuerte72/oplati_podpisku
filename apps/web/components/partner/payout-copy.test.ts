import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PAYOUT_MANUAL_NOTE, payoutAcceptedMessage } from './payout-copy.ts';

describe('тексты выплаты партнёру (R-3)', () => {
  it('говорит, что баланс в долларах, а платим рублями по курсу дня выплаты', () => {
    // Партнёр видит весь кабинет в $, а деньги получает в ₽ через менеджера.
    // Курс нигде не фиксируется технически (выплаты ручные — решение владельца),
    // поэтому единственная защита от спора «а почему столько» — сказать правило
    // до подачи заявки, а не в переписке после.
    expect(PAYOUT_MANUAL_NOTE).toMatch(/доллар/i);
    expect(PAYOUT_MANUAL_NOTE).toMatch(/рубл/i);
    expect(PAYOUT_MANUAL_NOTE).toMatch(/курс/i);
    expect(PAYOUT_MANUAL_NOTE).toMatch(/вручную/i);
  });

  it('сообщение о принятой заявке несёт то же правило и сумму', () => {
    const msg = payoutAcceptedMessage('$12.34');

    expect(msg).toContain('$12.34');
    expect(msg).toMatch(/рубл/i);
    expect(msg).toMatch(/курс/i);
  });

  it('в кабинете нет своей копии формулировки — источник один', () => {
    // Текст жил двумя независимыми строками (модалка и сообщение об успехе), и
    // правка одной оставляла вторую врать.
    const src = readFileSync(join(import.meta.dirname, 'PartnerCabinet.tsx'), 'utf8');

    expect(src).not.toMatch(/рабочих дн/i);
    expect(src).not.toMatch(/уточним\s+реквизиты/i);
  });
});
