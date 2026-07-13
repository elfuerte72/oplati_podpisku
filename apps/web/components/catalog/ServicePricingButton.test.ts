import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { ServicePricingButton } from './ServicePricingButton';

describe('ServicePricingButton', () => {
  it('показывает кнопку официального прайса для каталожного сервиса', () => {
    const html = renderToStaticMarkup(
      createElement(ServicePricingButton, {
        slug: 'chatgpt-plus',
        onOpenExternalLink: vi.fn(),
      }),
    );

    expect(html).toContain('type="button"');
    expect(html).toContain('Открыть прайс сервиса');
  });

  it('не показывает кнопку для неизвестного или custom-сервиса', () => {
    const html = renderToStaticMarkup(
      createElement(ServicePricingButton, {
        slug: 'custom-service',
        onOpenExternalLink: vi.fn(),
      }),
    );

    expect(html).toBe('');
  });
});
