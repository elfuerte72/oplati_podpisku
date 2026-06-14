/**
 * Идемпотентный seed каталога услуг.
 *
 * Запуск: `pnpm --filter @oplati/db db:seed` (загружает `.env` из корня монорепы).
 *
 * Стратегия: UPSERT по `services.slug` (INSERT ... ON CONFLICT (slug) DO UPDATE).
 * Повторный запуск безопасен — обновит поля, новых строк не создаст.
 *
 * Тарифы и USD-цены актуализированы веб-ресёрчем (июнь 2026, ориентир США) —
 * по нескольку потребительских уровней на сервис (ChatGPT Go/Plus/Pro, Claude
 * Pro/Max, стриминг с/без рекламы и т.п.). Кнопочный каталог (web + Telegram)
 * рендерит ВСЕ USD-тарифы автоматически из `pricing_policy.tiers[]`.
 *
 * Правила, которые нельзя нарушать (иначе сломается матчинг заказа):
 *   - В пределах одного сервиса `tier.name` ДОЛЖНЫ быть уникальны: web-флоу
 *     (`/api/orders/propose`) находит тариф по имени. Сейчас все уровни —
 *     помесячные (`period: 'month'`); годовые добавлять отдельной итерацией
 *     вместе с доработкой матчинга на (name + period).
 *   - `originalAmount` — USD-центы (источник цены витрины × живой курс).
 *   - `priceRub` — placeholder (в копейках), на витрине НЕ используется (там
 *     пересчёт по живому курсу). Считается helper'ом `usd()` ниже.
 *
 * Цены — справочные на момент ресёрча; владелец сверяет перед production
 * (часть взята из агрегаторов, не из живых официальных pricing-страниц).
 *
 * Airbnb уникален: pricing_policy.tiers содержит dummy-tier с originalAmount=1
 * (≤ 1 цента — маркер «индивидуальная цена», см. lib/catalog/build.ts). Кнопочный
 * флоу для таких сервисов запрашивает сумму у клиента; фактическая стоимость
 * заполняется в orders.amount_rub под каждый заказ.
 */

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { inArray } from 'drizzle-orm';
import { pricingPolicy, type PricingPolicy, type ServiceTier } from '@oplati/types';
import pino from 'pino';
import { services } from '../src/schema.ts';

const logger = pino({ name: 'seed-catalog' });

/**
 * Сервисы-дубли/без собственной подписки — деактивируем (is_active=false),
 * чтобы не висели в каталоге без цен и не путали AI-поиск:
 *   - `midjourney`  — пустой дубль `midjourney-basic` (тот с тарифами);
 *   - `claude-code` — НЕ отдельная подписка: доступ даёт `claude-pro`
 *                     (Claude Pro/Max), иначе была бы дублирующая карточка.
 * Список идемпотентен: если slug нет — no-op.
 */
const DEPRECATED_SLUGS: readonly string[] = ['midjourney', 'claude-code'];

/** Справочный курс и маржа — только для placeholder `priceRub` (не витрина). */
const RATE_HINT = 95.5;
const MARGIN = 0.15;

/**
 * Конструктор тарифа из долларовой цены. `originalAmount` (USD-центы) —
 * источник правды витрины; `priceRub` — placeholder в копейках для прохождения
 * zod-валидации (.positive()), фактическая рублёвая сумма считается по живому
 * курсу в момент заказа.
 */
function usd(name: string, dollars: number, period: 'month' | 'year' = 'month'): ServiceTier {
  return {
    name,
    period,
    originalAmount: Math.round(dollars * 100),
    currency: 'USD',
    priceRub: Math.max(1, Math.round(dollars * RATE_HINT * (1 + MARGIN) * 100)),
  };
}

/** dummy-tier для сервисов с индивидуальной ценой (Airbnb): сумму вводит клиент. */
const CUSTOM_AMOUNT_TIER: ServiceTier = {
  name: 'Booking',
  period: 'month',
  originalAmount: 1,
  currency: 'USD',
  priceRub: 1,
};

type CatalogEntry = {
  slug: string;
  name: string;
  description?: string;
  category: string;
  requiresKyc: boolean;
  pricingPolicy: PricingPolicy;
};

function policy(tiers: ServiceTier[]): PricingPolicy {
  return { tiers, margin: MARGIN };
}

const CATALOG: readonly CatalogEntry[] = [
  // ─── AI ──────────────────────────────────────────────────────────────────
  {
    slug: 'chatgpt-plus',
    name: 'ChatGPT',
    description: 'AI-ассистент от OpenAI',
    category: 'ai',
    requiresKyc: false,
    pricingPolicy: policy([
      usd('Go', 8),
      usd('Plus', 20),
      usd('Pro 5x', 100),
      usd('Pro', 200),
    ]),
  },
  {
    slug: 'claude-pro',
    name: 'Claude',
    description: 'AI-ассистент от Anthropic',
    category: 'ai',
    requiresKyc: false,
    pricingPolicy: policy([usd('Pro', 20), usd('Max 5x', 100), usd('Max 20x', 200)]),
  },
  {
    slug: 'midjourney-basic',
    name: 'Midjourney',
    description: 'AI-генерация изображений',
    category: 'ai',
    requiresKyc: false,
    pricingPolicy: policy([
      usd('Basic', 10),
      usd('Standard', 30),
      usd('Pro', 60),
      usd('Mega', 120),
    ]),
  },
  {
    slug: 'cursor-pro',
    name: 'Cursor',
    description: 'AI code editor',
    category: 'ai',
    requiresKyc: false,
    pricingPolicy: policy([usd('Pro', 20), usd('Pro+', 60), usd('Ultra', 200)]),
  },
  {
    slug: 'github-copilot',
    name: 'GitHub Copilot',
    description: 'AI-помощник для кода',
    category: 'ai',
    requiresKyc: false,
    pricingPolicy: policy([usd('Pro', 10), usd('Pro+', 39)]),
  },
  {
    slug: 'gemini-advanced',
    name: 'Google Gemini',
    description: 'AI-ассистент от Google',
    category: 'ai',
    requiresKyc: false,
    pricingPolicy: policy([usd('Plus', 7.99), usd('Pro', 19.99), usd('Ultra', 99.99)]),
  },
  {
    slug: 'grok-pro',
    name: 'Grok',
    description: 'AI-ассистент от xAI',
    category: 'ai',
    requiresKyc: false,
    pricingPolicy: policy([
      usd('SuperGrok Lite', 10),
      usd('SuperGrok', 30),
      usd('SuperGrok Heavy', 300),
    ]),
  },
  {
    slug: 'mistral-pro',
    name: 'Mistral Le Chat',
    description: 'AI-ассистент от Mistral',
    category: 'ai',
    requiresKyc: false,
    pricingPolicy: policy([usd('Pro', 14.99)]),
  },
  {
    slug: 'perplexity-pro',
    name: 'Perplexity',
    description: 'AI-поиск',
    category: 'ai',
    requiresKyc: false,
    pricingPolicy: policy([usd('Pro', 20), usd('Max', 200)]),
  },
  {
    slug: 'windsurf-pro',
    name: 'Windsurf',
    description: 'AI code editor',
    category: 'ai',
    requiresKyc: false,
    pricingPolicy: policy([usd('Pro', 20), usd('Max', 200)]),
  },

  // ─── Streaming ─────────────────────────────────────────────────────────────
  {
    slug: 'netflix-premium',
    name: 'Netflix',
    description: 'Видеостриминг',
    category: 'streaming',
    requiresKyc: false,
    pricingPolicy: policy([
      usd('С рекламой', 8.99),
      usd('Standard', 19.99),
      usd('Premium', 26.99),
    ]),
  },
  {
    slug: 'spotify-premium',
    name: 'Spotify',
    description: 'Музыкальный стриминг',
    category: 'streaming',
    requiresKyc: false,
    pricingPolicy: policy([
      usd('Individual', 12.99),
      usd('Duo', 18.99),
      usd('Family', 21.99),
      usd('Student', 6.99),
    ]),
  },
  {
    slug: 'youtube-premium',
    name: 'YouTube Premium',
    description: 'Без рекламы + YouTube Music',
    category: 'streaming',
    requiresKyc: false,
    pricingPolicy: policy([
      usd('Individual', 15.99),
      usd('Family', 26.99),
      usd('Student', 8.99),
    ]),
  },
  {
    slug: 'apple-music',
    name: 'Apple Music',
    description: 'Музыкальный стриминг Apple',
    category: 'streaming',
    requiresKyc: false,
    pricingPolicy: policy([
      usd('Student', 5.99),
      usd('Individual', 10.99),
      usd('Family', 16.99),
    ]),
  },
  {
    slug: 'disney-plus',
    name: 'Disney+',
    description: 'Видеостриминг Disney',
    category: 'streaming',
    requiresKyc: false,
    pricingPolicy: policy([usd('С рекламой', 11.99), usd('Premium', 18.99)]),
  },
  {
    slug: 'hbo-max',
    name: 'HBO Max',
    description: 'Видеостриминг HBO Max',
    category: 'streaming',
    requiresKyc: false,
    pricingPolicy: policy([
      usd('С рекламой', 10.99),
      usd('Standard', 18.49),
      usd('Premium', 22.99),
    ]),
  },
  {
    slug: 'crunchyroll-mega-fan',
    name: 'Crunchyroll',
    description: 'Аниме-стриминг',
    category: 'streaming',
    requiresKyc: false,
    pricingPolicy: policy([
      usd('Fan', 9.99),
      usd('Mega Fan', 13.99),
      usd('Ultimate Fan', 17.99),
    ]),
  },

  // ─── Travel ────────────────────────────────────────────────────────────────
  {
    slug: 'airbnb',
    name: 'Airbnb (бронирование)',
    description: 'Бронирование жилья — индивидуальная цена под каждый заказ',
    category: 'travel',
    requiresKyc: true,
    pricingPolicy: policy([CUSTOM_AMOUNT_TIER]),
  },

  // ─── Productivity ───────────────────────────────────────────────────────────
  {
    slug: 'discord-nitro',
    name: 'Discord Nitro',
    description: 'Расширенные возможности Discord',
    category: 'productivity',
    requiresKyc: false,
    pricingPolicy: policy([usd('Nitro Basic', 2.99), usd('Nitro', 9.99)]),
  },
  {
    slug: 'linkedin-premium',
    name: 'LinkedIn Premium',
    description: 'LinkedIn Premium',
    category: 'productivity',
    requiresKyc: true,
    pricingPolicy: policy([usd('Career', 29.99), usd('Business', 59.99)]),
  },
  {
    slug: 'apple-one',
    name: 'Apple One',
    description: 'Подписка Apple One',
    category: 'productivity',
    requiresKyc: true,
    pricingPolicy: policy([
      usd('Individual', 19.95),
      usd('Family', 25.95),
      usd('Premier', 37.95),
    ]),
  },
  {
    slug: 'icloud-plus-200gb',
    name: 'iCloud+',
    description: 'Облачное хранилище Apple',
    category: 'productivity',
    requiresKyc: false,
    pricingPolicy: policy([
      usd('50GB', 0.99),
      usd('200GB', 2.99),
      usd('2TB', 9.99),
      usd('6TB', 29.99),
      usd('12TB', 59.99),
    ]),
  },
  {
    slug: 'notion-plus',
    name: 'Notion',
    description: 'Notion — рабочее пространство',
    category: 'productivity',
    requiresKyc: false,
    pricingPolicy: policy([usd('Plus', 12), usd('Business', 24)]),
  },
  {
    slug: 'figma-professional',
    name: 'Figma',
    description: 'Figma — дизайн (платное место)',
    category: 'productivity',
    requiresKyc: false,
    pricingPolicy: policy([
      usd('Full seat', 16),
      usd('Dev seat', 12),
      usd('Collab seat', 3),
    ]),
  },
  {
    slug: 'adobe-creative-cloud',
    name: 'Adobe Creative Cloud',
    description: 'Adobe Creative Cloud',
    category: 'productivity',
    requiresKyc: true,
    pricingPolicy: policy([
      usd('Photography', 9.99),
      usd('Single App', 22.99),
      usd('All Apps', 54.99),
      usd('All Apps Pro', 69.99),
    ]),
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

    if (DEPRECATED_SLUGS.length > 0) {
      const deactivated = await db
        .update(services)
        .set({ isActive: false })
        .where(inArray(services.slug, [...DEPRECATED_SLUGS]))
        .returning({ slug: services.slug });
      logger.info(
        { slugs: deactivated.map((r) => r.slug) },
        'deprecated services deactivated',
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
