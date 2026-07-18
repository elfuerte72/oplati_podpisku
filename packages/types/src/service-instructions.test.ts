import { describe, expect, it } from 'vitest';

import { servicePaymentInstructions } from './index.ts';

describe('servicePaymentInstructions', () => {
  it('принимает полную запись', () => {
    const parsed = servicePaymentInstructions.safeParse({
      requiresVpn: true,
      vpnLocation: 'США',
      requiredCurrency: 'USD',
      billingInstructions: 'Введи данные адреса США из сообщения с картой.',
      paymentUrl: 'https://chatgpt.com/#pricing',
      paymentNotes: 'Оплачивай в веб-версии.',
    });
    expect(parsed.success).toBe(true);
  });

  it('принимает минимальную запись — только requiresVpn', () => {
    const parsed = servicePaymentInstructions.safeParse({ requiresVpn: false });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.vpnLocation).toBeUndefined();
      expect(parsed.data.paymentUrl).toBeUndefined();
    }
  });

  it('отклоняет запись без requiresVpn', () => {
    expect(servicePaymentInstructions.safeParse({ vpnLocation: 'США' }).success).toBe(false);
  });

  it('отклоняет невалидный paymentUrl', () => {
    expect(
      servicePaymentInstructions.safeParse({ requiresVpn: true, paymentUrl: 'not-a-url' }).success,
    ).toBe(false);
  });

  it('отклоняет не-https paymentUrl (клиенту отдаём только защищённые ссылки)', () => {
    expect(
      servicePaymentInstructions.safeParse({
        requiresVpn: true,
        paymentUrl: 'http://example.com/pay',
      }).success,
    ).toBe(false);
  });

  it('отклоняет слишком длинные поля', () => {
    expect(
      servicePaymentInstructions.safeParse({
        requiresVpn: true,
        billingInstructions: 'x'.repeat(1001),
      }).success,
    ).toBe(false);
  });

  it('null/undefined — не запись (сервис без инструкции)', () => {
    expect(servicePaymentInstructions.safeParse(null).success).toBe(false);
    expect(servicePaymentInstructions.safeParse(undefined).success).toBe(false);
  });
});
