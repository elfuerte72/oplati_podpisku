-- Seed каталога AI-сервисов под план MVP (TZ.md, раздел 3).
-- 11 AI-сервисов с pricing_policy { type: 'fixed_usd', basePriceUsdCents: N }.
-- Деактивируем non-AI/Apple-Pay сервисы (план: Apple Pay вне MVP).

-- AI: подписочные сервисы
INSERT INTO services (slug, name, description, category, pricing_policy, requires_kyc, is_active) VALUES
  ('chatgpt-plus',    'ChatGPT Plus',         'OpenAI Plus, $20/мес',              'ai', '{"type":"fixed_usd","basePriceUsdCents":2000}'::jsonb, false, true),
  ('claude-pro',      'Claude Pro',           'Anthropic Pro, $20/мес',             'ai', '{"type":"fixed_usd","basePriceUsdCents":2000}'::jsonb, false, true),
  ('gemini-advanced', 'Gemini Advanced',      'Google AI Premium, $19.99/мес',      'ai', '{"type":"fixed_usd","basePriceUsdCents":2000}'::jsonb, false, true),
  ('perplexity-pro',  'Perplexity Pro',       'Perplexity Pro, $20/мес',            'ai', '{"type":"fixed_usd","basePriceUsdCents":2000}'::jsonb, false, true),
  ('mistral-pro',     'Mistral Pro',          'Le Chat Pro, ~$15/мес',              'ai', '{"type":"fixed_usd","basePriceUsdCents":1500}'::jsonb, false, true),
  ('grok-pro',        'Grok Pro',             'X / Grok Premium, $16/мес',          'ai', '{"type":"fixed_usd","basePriceUsdCents":1600}'::jsonb, false, true),
  ('github-copilot',  'GitHub Copilot',       'GitHub Copilot Individual, $10/мес', 'ai', '{"type":"fixed_usd","basePriceUsdCents":1000}'::jsonb, false, true),
  ('cursor-pro',      'Cursor Pro',           'Cursor IDE Pro, $20/мес',            'ai', '{"type":"fixed_usd","basePriceUsdCents":2000}'::jsonb, false, true),
  ('claude-code',     'Claude Code',          'Anthropic Claude Code, $20/мес',     'ai', '{"type":"fixed_usd","basePriceUsdCents":2000}'::jsonb, false, true),
  ('windsurf-pro',    'Windsurf Pro',         'Codeium Windsurf Pro, $15/мес',      'ai', '{"type":"fixed_usd","basePriceUsdCents":1500}'::jsonb, false, true),
  ('midjourney',      'Midjourney',           'Midjourney Basic Plan, $10/мес',     'ai', '{"type":"fixed_usd","basePriceUsdCents":1000}'::jsonb, false, true)
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  category = EXCLUDED.category,
  pricing_policy = EXCLUDED.pricing_policy,
  requires_kyc = EXCLUDED.requires_kyc,
  is_active = EXCLUDED.is_active;

-- Существующие non-AI сервисы (если есть в seed) — деактивируем для MVP:
-- Apple One / Discord Nitro / LinkedIn / Netflix / Spotify / YouTube / Airbnb / iCloud / Google One / Unity.
UPDATE services SET is_active = false
WHERE slug IN ('apple-one', 'discord-nitro', 'linkedin-premium', 'netflix-premium',
               'spotify-premium', 'youtube-premium', 'airbnb', 'icloud',
               'google-one', 'unity-asset-store', 'midjourney-basic');
