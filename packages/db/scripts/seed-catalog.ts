/**
 * Идемпотентный seed каталога услуг.
 *
 * Запуск: `pnpm --filter @oplati/db db:seed` (загружает `.env` из корня монорепы).
 *
 * Стратегия: UPSERT по `services.slug` (INSERT ... ON CONFLICT (slug) DO UPDATE).
 * Повторный запуск безопасен — обновит поля, новых строк не создаст.
 *
 * Цены — placeholder на основе известных USD-прайсов × курс ~95₽/USD × margin 15%.
 * TODO: верифицировать с владельцем перед production
 * (см. `.ai-factory/plans/feature-db-extended-schema.md`, Task 10).
 *
 * Airbnb уникален: pricing_policy.tiers содержит dummy-tier с priceRub=1
 * (минимальное валидное значение — zod-схема `serviceTier.priceRub` требует
 * .positive(), поэтому 0 не проходит). Фактическая стоимость бронирования
 * заполняется в orders.amount_rub под каждый заказ; dummy-tier удовлетворяет
 * валидации (tiers.min(1) + priceRub.positive()) без правок типов.
 */

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { pricingPolicy, type PricingPolicy } from '@oplati/types';
import pino from 'pino';
import { services } from '../src/schema.ts';

const logger = pino({ name: 'seed-catalog' });

type CatalogEntry = {
  slug: string;
  name: string;
  description?: string;
  category: string;
  requiresKyc: boolean;
  pricingPolicy: PricingPolicy;
};

const CATALOG: readonly CatalogEntry[] = [
  {
    slug: 'claude-pro',
    name: 'Claude Pro',
    description: 'AI-ассистент от Anthropic',
    category: 'ai',
    requiresKyc: false,
    pricingPolicy: {
      tiers: [
        {
          name: 'Pro',
          period: 'month',
          priceRub: 253000,
          originalAmount: 2000,
          currency: 'USD',
        },
      ],
      margin: 0.15,
    },
  },
  {
    slug: 'chatgpt-plus',
    name: 'ChatGPT Plus',
    description: 'AI-ассистент от OpenAI',
    category: 'ai',
    requiresKyc: false,
    pricingPolicy: {
      tiers: [
        {
          name: 'Plus',
          period: 'month',
          priceRub: 253000,
          originalAmount: 2000,
          currency: 'USD',
        },
      ],
      margin: 0.15,
    },
  },
  {
    slug: 'netflix-premium',
    name: 'Netflix Premium',
    description: 'Стриминг — Premium-план',
    category: 'streaming',
    requiresKyc: false,
    pricingPolicy: {
      tiers: [
        {
          name: 'Premium',
          period: 'month',
          priceRub: 290800,
          originalAmount: 2299,
          currency: 'USD',
        },
      ],
      margin: 0.15,
    },
  },
  {
    slug: 'spotify-premium',
    name: 'Spotify Premium',
    description: 'Музыкальный стриминг — Individual',
    category: 'streaming',
    requiresKyc: false,
    pricingPolicy: {
      tiers: [
        {
          name: 'Individual',
          period: 'month',
          priceRub: 139100,
          originalAmount: 1099,
          currency: 'USD',
        },
      ],
      margin: 0.15,
    },
  },
  {
    slug: 'airbnb',
    name: 'Airbnb (бронирование)',
    description: 'Бронирование жилья — индивидуальная цена под каждый заказ',
    category: 'travel',
    requiresKyc: true,
    // dummy-tier: фактическая цена в orders.amount_rub
    pricingPolicy: {
      tiers: [
        {
          name: 'Booking',
          period: 'month',
          priceRub: 1,
          originalAmount: 1,
          currency: 'USD',
        },
      ],
      margin: 0.15,
    },
  },
  {
    slug: 'youtube-premium',
    name: 'YouTube Premium',
    description: 'Без рекламы + YouTube Music',
    category: 'streaming',
    requiresKyc: false,
    pricingPolicy: {
      tiers: [
        {
          name: 'Individual',
          period: 'month',
          priceRub: 177100,
          originalAmount: 1399,
          currency: 'USD',
        },
      ],
      margin: 0.15,
    },
  },
  {
    slug: 'discord-nitro',
    name: 'Discord Nitro',
    description: 'Расширенные возможности Discord',
    category: 'productivity',
    requiresKyc: false,
    pricingPolicy: {
      tiers: [
        {
          name: 'Nitro',
          period: 'month',
          priceRub: 126500,
          originalAmount: 999,
          currency: 'USD',
        },
      ],
      margin: 0.15,
    },
  },
  {
    slug: 'midjourney-basic',
    name: 'Midjourney Basic',
    description: 'AI-генерация изображений — Basic-план',
    category: 'ai',
    requiresKyc: false,
    pricingPolicy: {
      tiers: [
        {
          name: 'Basic',
          period: 'month',
          priceRub: 126500,
          originalAmount: 1000,
          currency: 'USD',
        },
      ],
      margin: 0.15,
    },
  },
  {
    slug: 'linkedin-premium',
    name: 'LinkedIn Premium',
    description: 'Career-план LinkedIn',
    category: 'productivity',
    requiresKyc: true,
    pricingPolicy: {
      tiers: [
        {
          name: 'Career',
          period: 'month',
          priceRub: 379500,
          originalAmount: 2999,
          currency: 'USD',
        },
      ],
      margin: 0.15,
    },
  },
  {
    slug: 'apple-one',
    name: 'Apple One',
    description: 'Подписка Apple One — Individual',
    category: 'productivity',
    requiresKyc: true,
    pricingPolicy: {
      tiers: [
        {
          name: 'Individual',
          period: 'month',
          priceRub: 253000,
          originalAmount: 1995,
          currency: 'USD',
        },
      ],
      margin: 0.15,
    },
  },
  {
    slug: 'icloud-plus-200gb',
    name: 'iCloud+ 200GB',
    description: 'iCloud+ 200GB — облачное хранилище Apple',
    category: 'productivity',
    requiresKyc: false,
    pricingPolicy: {
      tiers: [
        {
          name: '200GB',
          period: 'month',
          priceRub: 37973,
          originalAmount: 299,
          currency: 'USD',
        },
      ],
      margin: 0.15,
    },
  },
  {
    slug: 'apple-music',
    name: 'Apple Music',
    description: 'Apple Music — Individual',
    category: 'streaming',
    requiresKyc: false,
    pricingPolicy: {
      tiers: [
        {
          name: 'Individual',
          period: 'month',
          priceRub: 139573,
          originalAmount: 1099,
          currency: 'USD',
        },
      ],
      margin: 0.15,
    },
  },
  {
    slug: 'notion-plus',
    name: 'Notion Plus',
    description: 'Notion Plus — индивидуальный тариф',
    category: 'productivity',
    requiresKyc: false,
    pricingPolicy: {
      tiers: [
        {
          name: 'Plus',
          period: 'month',
          priceRub: 127000,
          originalAmount: 1000,
          currency: 'USD',
        },
      ],
      margin: 0.15,
    },
  },
  {
    slug: 'figma-professional',
    name: 'Figma Professional',
    description: 'Figma Professional — Editor seat',
    category: 'productivity',
    requiresKyc: false,
    pricingPolicy: {
      tiers: [
        {
          name: 'Professional',
          period: 'month',
          priceRub: 190500,
          originalAmount: 1500,
          currency: 'USD',
        },
      ],
      margin: 0.15,
    },
  },
  {
    slug: 'github-copilot',
    name: 'GitHub Copilot',
    description: 'GitHub Copilot Individual',
    category: 'productivity',
    requiresKyc: false,
    pricingPolicy: {
      tiers: [
        {
          name: 'Individual',
          period: 'month',
          priceRub: 127000,
          originalAmount: 1000,
          currency: 'USD',
        },
      ],
      margin: 0.15,
    },
  },
  {
    slug: 'adobe-creative-cloud',
    name: 'Adobe Creative Cloud',
    description: 'Adobe Creative Cloud (All Apps)',
    category: 'productivity',
    requiresKyc: true,
    pricingPolicy: {
      tiers: [
        {
          name: 'All Apps',
          period: 'month',
          priceRub: 761873,
          originalAmount: 5999,
          currency: 'USD',
        },
      ],
      margin: 0.15,
    },
  },
  {
    slug: 'disney-plus',
    name: 'Disney+',
    description: 'Disney+ — стриминг',
    category: 'streaming',
    requiresKyc: false,
    pricingPolicy: {
      tiers: [
        {
          name: 'Standard',
          period: 'month',
          priceRub: 126873,
          originalAmount: 999,
          currency: 'USD',
        },
      ],
      margin: 0.15,
    },
  },
  {
    slug: 'hbo-max',
    name: 'HBO Max',
    description: 'Max (HBO) — стриминг',
    category: 'streaming',
    requiresKyc: false,
    pricingPolicy: {
      tiers: [
        {
          name: 'Standard',
          period: 'month',
          priceRub: 126873,
          originalAmount: 999,
          currency: 'USD',
        },
      ],
      margin: 0.15,
    },
  },
  {
    slug: 'crunchyroll-mega-fan',
    name: 'Crunchyroll Mega Fan',
    description: 'Crunchyroll Mega Fan — аниме-стриминг',
    category: 'streaming',
    requiresKyc: false,
    pricingPolicy: {
      tiers: [
        {
          name: 'Mega Fan',
          period: 'month',
          priceRub: 152273,
          originalAmount: 1199,
          currency: 'USD',
        },
      ],
      margin: 0.15,
    },
  },
  {
    slug: 'cursor-pro',
    name: 'Cursor Pro',
    description: 'Cursor Pro — AI code editor',
    category: 'ai',
    requiresKyc: false,
    pricingPolicy: {
      tiers: [
        {
          name: 'Pro',
          period: 'month',
          priceRub: 254000,
          originalAmount: 2000,
          currency: 'USD',
        },
      ],
      margin: 0.15,
    },
  },
];

async function main(): Promise<void> {
  // Supabase: direct hostname `db.<ref>.supabase.co` сейчас не резолвится,
  // pooler (`*.pooler.supabase.com:6543`) — единственный рабочий путь.
  // prepare:false обязательно для pgbouncer transaction-mode.
  const url = process.env.DATABASE_URL ?? process.env.DATABASE_URL_DIRECT;
  if (!url) {
    throw new Error(
      'DATABASE_URL or DATABASE_URL_DIRECT must be set (see .env in repo root)',
    );
  }

  logger.info({ count: CATALOG.length }, 'starting catalog seed');

  const client = postgres(url, { max: 1, prepare: false });
  const db = drizzle(client);

  try {
    for (const entry of CATALOG) {
      // Инвариант «Zod на границах»: валидируем структуру pricing_policy
      // перед записью в jsonb-колонку.
      const validatedPolicy = pricingPolicy.parse(entry.pricingPolicy);

      await db
        .insert(services)
        .values({
          slug: entry.slug,
          name: entry.name,
          description: entry.description ?? null,
          category: entry.category,
          requiresKyc: entry.requiresKyc,
          pricingPolicy: validatedPolicy,
          isActive: true,
        })
        .onConflictDoUpdate({
          target: services.slug,
          set: {
            name: entry.name,
            description: entry.description ?? null,
            category: entry.category,
            requiresKyc: entry.requiresKyc,
            pricingPolicy: validatedPolicy,
            isActive: true,
          },
        });

      logger.info(
        {
          slug: entry.slug,
          name: entry.name,
          tiers: validatedPolicy.tiers.length,
          requiresKyc: entry.requiresKyc,
        },
        'service seeded',
      );
    }

    logger.info({ count: CATALOG.length }, 'catalog seed complete');
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((err: unknown) => {
  logger.error({ err }, 'seed failed');
  process.exit(1);
});
