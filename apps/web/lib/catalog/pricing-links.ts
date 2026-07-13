/**
 * Официальные страницы тарифов активного каталога.
 *
 * Для сервисов без фиксированного публичного прайса ведём на ближайшую
 * официальную точку выбора суммы: пополнение Apple Account и @PremiumBot.
 * Ссылки проверены по страницам самих сервисов 2026-07-13.
 */
const SERVICE_PRICING_URLS: Readonly<Record<string, string>> = {
  'chatgpt-plus': 'https://openai.com/chatgpt/pricing/',
  'claude-pro': 'https://claude.com/pricing',
  'midjourney-basic':
    'https://docs.midjourney.com/hc/en-us/articles/27870484040333-Comparing-Midjourney-Plans',
  'cursor-pro': 'https://cursor.com/pricing',
  'gemini-advanced': 'https://gemini.google/us/subscriptions/?hl=en',
  'perplexity-pro': 'https://www.perplexity.ai/pro',
  suno: 'https://suno.com/pricing',
  higgsfield: 'https://higgsfield.ai/pricing',
  'apple-music': 'https://www.apple.com/apple-music/',
  'apple-app-store': 'https://support.apple.com/en-us/118297',
  'icloud-plus-200gb': 'https://support.apple.com/en-us/108047',
  'figma-professional': 'https://www.figma.com/pricing/',
  'telegram-premium': 'https://t.me/premiumbot',
};

export function servicePricingUrl(slug: string | null | undefined): string | null {
  if (!slug) return null;
  return SERVICE_PRICING_URLS[slug] ?? null;
}
