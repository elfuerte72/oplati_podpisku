import { describe, expect, it } from 'vitest';

import { servicePricingUrl } from './pricing-links';

describe('servicePricingUrl', () => {
  it.each([
    ['chatgpt-plus', 'https://openai.com/chatgpt/pricing/'],
    ['claude-pro', 'https://claude.com/pricing'],
    [
      'midjourney-basic',
      'https://docs.midjourney.com/hc/en-us/articles/27870484040333-Comparing-Midjourney-Plans',
    ],
    ['cursor-pro', 'https://cursor.com/pricing'],
    ['gemini-advanced', 'https://gemini.google/us/subscriptions/?hl=en'],
    ['perplexity-pro', 'https://www.perplexity.ai/pro'],
    ['suno', 'https://suno.com/pricing'],
    ['higgsfield', 'https://higgsfield.ai/pricing'],
    ['apple-music', 'https://www.apple.com/apple-music/'],
    ['apple-app-store', 'https://support.apple.com/en-us/118297'],
    ['icloud-plus-200gb', 'https://support.apple.com/en-us/108047'],
    ['figma-professional', 'https://www.figma.com/pricing/'],
    ['telegram-premium', 'https://telegram.me/premiumbot'],
  ])('возвращает официальный прайс для активного сервиса %s', (slug, url) => {
    expect(servicePricingUrl(slug)).toBe(url);
  });

  it('возвращает null для custom-заказа или неизвестного сервиса', () => {
    expect(servicePricingUrl(null)).toBeNull();
    expect(servicePricingUrl(undefined)).toBeNull();
    expect(servicePricingUrl('custom-service')).toBeNull();
  });
});
