import { describe, expect, it } from 'vitest';

import { paymentRulesHtml } from './templates';

describe('paymentRulesHtml', () => {
  it('напоминает оплачивать в веб-версии сервиса, а не в мобильном приложении', () => {
    const html = paymentRulesHtml(2000);

    expect(html).toContain('в веб-версии сервиса');
    expect(html).toContain('не в мобильном приложении');
  });
});
