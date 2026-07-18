import { describe, expect, it } from 'vitest';

import { instructionPoints } from './instructions';

describe('instructionPoints', () => {
  it('полная запись: VPN-локация, валюта, billing и notes — в порядке важности', () => {
    const points = instructionPoints({
      requiresVpn: true,
      vpnLocation: 'США',
      requiredCurrency: 'USD',
      billingInstructions: 'Введи адрес США.',
      paymentNotes: 'Оплачивай в браузере.',
    });
    expect(points).toEqual([
      'Включи VPN с локацией США.',
      'Проверь, что цена на сайте сервиса отображается в USD.',
      'Введи адрес США.',
      'Оплачивай в браузере.',
    ]);
  });

  it('requiresVpn без локации — общий пункт про VPN', () => {
    expect(instructionPoints({ requiresVpn: true })).toEqual(['Включи VPN перед оплатой.']);
  });

  it('сервис без VPN получает явный пункт «VPN не нужен» (не пустой блок)', () => {
    const points = instructionPoints({ requiresVpn: false });
    expect(points).toEqual(['VPN для оплаты не нужен.']);
  });
});
