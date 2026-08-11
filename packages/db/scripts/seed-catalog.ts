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
 *   - В пределах одного сервиса пара (`tier.name`, `tier.period`) ДОЛЖНА быть
 *     уникальна: web/Telegram-флоу находит тариф по имени + периоду.
 *   - `originalAmount` — USD-центы (источник цены витрины × живой курс).
 *   - `priceRub` — placeholder (в копейках), на витрине НЕ используется (там
 *     пересчёт по живому курсу). Считается helper'ом `usd()` ниже.
 *
 * Цены — справочные на момент ресёрча; владелец сверяет перед production.
 *
 * Сервисы с индивидуальной ценой (Hostinger, «пополнения» App Store и архивный
 * Steam) уникальны: pricing_policy.tiers содержит dummy-tier с originalAmount=1
 * (≤ 1 цента — маркер «индивидуальная цена», см. lib/catalog/build.ts).
 * Кнопочный флоу для таких сервисов запрашивает сумму у клиента; фактическая
 * стоимость заполняется в orders.amount_rub под каждый заказ.
 *
 * Убранные из витрины сервисы живут в ARCHIVED_CATALOG (is_active=false) —
 * записи сохранены для быстрого восстановления.
 */

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { inArray } from 'drizzle-orm';
import {
  pricingPolicy,
  servicePaymentInstructions,
  type PricingPolicy,
  type ServicePaymentInstructions,
  type ServiceTier,
  assertUniqueTierKeys,
} from '@oplati/types';
import pino from 'pino';
import { services } from '../src/schema.ts';

const logger = pino({ name: 'seed-catalog' });

/**
 * Сервисы-дубли/без собственной подписки — деактивируем (is_active=false),
 * чтобы не висели в каталоге без цен и не путали AI-поиск:
 *   - `midjourney`  — пустой дубль `midjourney-basic` (тот с тарифами);
 *   - `claude-code` — НЕ отдельная подписка: доступ даёт `claude-pro`
 *                     (Claude Pro/Max), иначе была бы дублирующая карточка.
 *   - `hbo-max`, `disney-plus`, `crunchyroll-mega-fan`, `mistral-pro`,
 *     `windsurf-pro` — выведены из витрины решением владельца 2026-06-29
 *     (сужаем каталог, чтобы список не был перегружен).
 * Список идемпотентен: если slug нет — no-op. Деактивация (is_active=false),
 * а не DELETE: история заказов и append-only `order_events` сохраняются.
 */
const DEPRECATED_SLUGS: readonly string[] = [
  'midjourney',
  'claude-code',
  'hbo-max',
  'disney-plus',
  'crunchyroll-mega-fan',
  'mistral-pro',
  'windsurf-pro',
  'github-copilot',
];

/** Справочный курс и маржа — только для placeholder `priceRub` (не витрина). */
const RATE_HINT = 95.5;
const MARGIN = 0.3;

/**
 * Конструктор тарифа из долларовой цены. `originalAmount` (USD-центы) —
 * источник правды витрины; `priceRub` — placeholder в копейках для прохождения
 * zod-валидации (.positive()), фактическая рублёвая сумма считается по живому
 * курсу в момент заказа.
 */
function usd(
  name: string,
  dollars: number,
  period: 'month' | 'quarter' | 'year' = 'month',
): ServiceTier {
  return {
    name,
    period,
    originalAmount: Math.round(dollars * 100),
    currency: 'USD',
    priceRub: Math.max(1, Math.round(dollars * RATE_HINT * (1 + MARGIN) * 100)),
  };
}

/** dummy-tier для сервисов с индивидуальной ценой (Hostinger, Airbnb): сумму вводит клиент. */
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
  /** Правила оплаты на сайте сервиса (ТЗ «клиентский путь» 2026-07). */
  paymentInstructions?: ServicePaymentInstructions;
};

function policy(tiers: ServiceTier[]): PricingPolicy {
  return { tiers, margin: MARGIN };
}

// ─── Правила оплаты на сайте сервиса ──────────────────────────────────────
//
// VPN нельзя показывать общим советом (ТЗ §5) — для каждого сервиса храним
// отдельные требования: нужен ли VPN, локация, валюта, billing-данные и ссылка
// на страницу оплаты. Ссылки — те же проверенные, что в pricing-links.ts
// (сверены по сайтам сервисов 2026-07-13).

/** Billing-подсказка по умолчанию: адрес США приходит вместе с картой. */
const US_BILLING_INSTRUCTIONS =
  'В Billing Address введи данные адреса США — они придут вместе с реквизитами карты в Telegram и видны в личном кабинете.';

/** Общая особенность: платим в веб-версии, не в мобильном приложении. */
const WEB_CHECKOUT_NOTE =
  'Оплачивай в веб-версии сервиса — в браузере, не в мобильном приложении.';

/** Типовые правила для сервисов с оплатой на сайте: VPN США + цена в USD. */
function usInstructions(paymentUrl: string, paymentNotes?: string): ServicePaymentInstructions {
  return {
    requiresVpn: true,
    vpnLocation: 'США',
    requiredCurrency: 'USD',
    billingInstructions: US_BILLING_INSTRUCTIONS,
    paymentUrl,
    paymentNotes: paymentNotes ?? WEB_CHECKOUT_NOTE,
  };
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
    paymentInstructions: usInstructions('https://chatgpt.com/#pricing'),
  },
  {
    slug: 'claude-pro',
    name: 'Claude',
    description: 'AI-ассистент от Anthropic',
    category: 'ai',
    requiresKyc: false,
    pricingPolicy: policy([usd('Pro', 20), usd('Max 5x', 100), usd('Max 20x', 200)]),
    paymentInstructions: usInstructions('https://claude.ai/upgrade'),
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
    paymentInstructions: usInstructions('https://www.midjourney.com/account'),
  },
  {
    slug: 'cursor-pro',
    name: 'Cursor',
    description: 'AI code editor',
    category: 'ai',
    requiresKyc: false,
    pricingPolicy: policy([usd('Pro', 20), usd('Pro+', 60), usd('Ultra', 200)]),
    paymentInstructions: usInstructions('https://cursor.com/settings'),
  },
  {
    slug: 'gemini-advanced',
    name: 'Google Gemini',
    description: 'AI-ассистент от Google',
    category: 'ai',
    requiresKyc: false,
    // Сверено по сайту 2026-07-08: Plus $4.99 (был снижен с $7.99), Pro $19.99, Ultra от $99.99.
    pricingPolicy: policy([usd('Plus', 4.99), usd('Pro', 19.99), usd('Ultra', 99.99)]),
    paymentInstructions: usInstructions('https://gemini.google/us/subscriptions/?hl=en'),
  },
  {
    slug: 'perplexity-pro',
    name: 'Perplexity',
    description: 'AI-поиск',
    category: 'ai',
    requiresKyc: false,
    pricingPolicy: policy([usd('Pro', 20), usd('Max', 200)]),
    paymentInstructions: usInstructions('https://www.perplexity.ai/pro'),
  },
  {
    slug: 'suno',
    name: 'Suno',
    description: 'AI-генерация музыки',
    category: 'ai',
    requiresKyc: false,
    pricingPolicy: policy([usd('Pro', 10), usd('Premier', 30)]),
    paymentInstructions: usInstructions('https://suno.com/account'),
  },
  {
    slug: 'higgsfield',
    name: 'Higgsfield',
    description: 'AI-генерация видео и изображений',
    category: 'ai',
    requiresKyc: false,
    // Higgsfield активно A/B-тестит цены. Сверено по сайту 2026-07-08: месячные
    // (monthly) тарифы Plus $59, Ultra $129 — на них выпускается карта, т.к. клиент
    // оформляет подписку помесячно (годовые per-month $47/$99 списываются сразу за
    // год, картой не покрываются). Starter ($19/мес годовой, 270 кредитов) убран:
    // слабый тариф + месячной цены на сайте по умолчанию не видно.
    pricingPolicy: policy([usd('Plus', 59), usd('Ultra', 129)]),
    paymentInstructions: usInstructions('https://higgsfield.ai/pricing'),
  },
  {
    slug: 'heygen',
    name: 'HeyGen',
    description: 'AI-видео с цифровыми аватарами и озвучкой',
    category: 'ai',
    requiresKyc: false,
    // Сверено по heygen.com/pricing 2026-07-27. Берём только МЕСЯЧНЫЕ цены:
    // годовые ($24/$39 за месяц) списываются сразу за год, картой такой платёж
    // не покрывается — тот же принцип, что у Higgsfield.
    //   Free ($0) — продавать нечего.
    //   Business ($149/мес + $20 за место) НЕ берём: сумма зависит от числа мест,
    //     и карта, выпущенная на базовые $149, не покроет счёт с местами.
    //   Enterprise — цена по запросу, витрине не подходит.
    pricingPolicy: policy([usd('Creator', 29), usd('Pro', 49)]),
    paymentInstructions: usInstructions('https://www.heygen.com/pricing'),
  },
  {
    slug: 'elevenlabs',
    name: 'ElevenLabs',
    description: 'AI-озвучка, синтез речи и дубляж',
    category: 'ai',
    requiresKyc: false,
    // Сверено по elevenlabs.io/pricing 2026-07-31. Берём МЕСЯЧНЫЕ цены: годовые
    // (10 месяцев вместо 12) списываются сразу за год — тот же принцип, что у
    // Higgsfield и HeyGen.
    //   Free ($0) — продавать нечего.
    //   Creator на сайте рекламируется как «$11 первый месяц (−50%)»; в витрину
    //     берём обычную цену $22, иначе со второго месяца клиент увидит списание
    //     вдвое больше обещанного, а карта будет выпущена на половину суммы.
    //   Business ($990/мес, 10 мест) НЕ берём: выше серверного потолка заказа
    //     ($500), propose_order отклонил бы такой заказ уже после выбора тарифа.
    //   Enterprise — цена по запросу, витрине не подходит.
    pricingPolicy: policy([
      usd('Starter', 6),
      usd('Creator', 22),
      usd('Pro', 99),
      usd('Scale', 299),
    ]),
    paymentInstructions: usInstructions('https://elevenlabs.io/pricing'),
  },

  // ─── Streaming ─────────────────────────────────────────────────────────────
  // Netflix / Spotify / YouTube Premium выведены из витрины 2026-07-07 (решение
  // владельца) — записи в ARCHIVED_CATALOG, деактивируются автоматически.
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
    paymentInstructions: usInstructions('https://www.apple.com/apple-music/'),
  },

  // ─── Productivity ───────────────────────────────────────────────────────────
  {
    slug: 'apple-app-store',
    name: 'App Store (пополнение)',
    description: 'Пополнение баланса Apple ID / App Store — сумму вводит клиент',
    category: 'productivity',
    requiresKyc: false,
    pricingPolicy: policy([CUSTOM_AMOUNT_TIER]),
    paymentInstructions: usInstructions('https://support.apple.com/en-us/118297', 'Пополняем баланс Apple Account — сумма зачисляется на твой Apple ID.'),
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
    paymentInstructions: usInstructions('https://support.apple.com/en-us/108047'),
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
    paymentInstructions: usInstructions('https://www.figma.com/pricing/'),
  },
  {
    slug: 'hostinger',
    name: 'Hostinger (оплата счёта)',
    description: 'Хостинг, VPS и домены — сумму вводит клиент',
    category: 'productivity',
    requiresKyc: false,
    // Подписки в нашем смысле у Hostinger нет: тариф оплачивается РАЗОВО за весь
    // срок (12/24/48 месяцев), цена зависит от срока, действующего промо и
    // допуслуг в корзине (домен, почта, SSL, лицензии). Фиксированного тарифа,
    // который можно показать кнопкой, не существует — отсюда custom-amount:
    // клиент вводит итог из корзины. Потолок остаётся общий, $500 (решение
    // владельца 2026-07-31): в него влезают все тарифы хостинга (Cloud на 48
    // месяцев — самый дорогой, ~$384) и VPS до KVM 4; редкий крупный VPS
    // (KVM 8 на 24 месяца, ~$624) уходит через оператора. Поднять потолок =
    // добавить slug в HIGH_VALUE_SERVICE_SLUGS (и три его зеркала).
    pricingPolicy: policy([CUSTOM_AMOUNT_TIER]),
    paymentInstructions: usInstructions(
      'https://www.hostinger.com/pricing',
      'Оплата разовая за весь срок (12/24/48 месяцев) — укажи ИТОГ из корзины Hostinger, а не цену за месяц. Домен, почта и другие допуслуги должны входить в эту же сумму. Оплачивай в веб-версии, не в приложении.',
    ),
  },

  // ─── Social ──────────────────────────────────────────────────────────────────
  {
    // Возвращён из архива 2026-07-03. Цены синхронизированы с офф. страницей
    // Telegram Premium (2026-07-04): месяц $6.49, год $49.99 — прежние
    // $4.99→$5.20 / $35.99 были устаревшими и занижали маржу (база меньше
    // реальной стоимости подписки). При fallback-курсе 77 и комиссии 30%:
    // месяц → 649,65 ₽, год → 5 004 ₽ (оба выше минимума терминала L&P 500 ₽).
    // 2-летний тариф (руб-фикс от Telegram) в USD-модель не заводим.
    slug: 'telegram-premium',
    name: 'Telegram Premium',
    description: 'Telegram Premium — расширенные возможности мессенджера',
    category: 'social',
    requiresKyc: false,
    pricingPolicy: policy([usd('Premium', 6.49), usd('Premium', 49.99, 'year')]),
    paymentInstructions: {
      requiresVpn: false,
      paymentUrl: 'https://t.me/PremiumBot',
      paymentNotes: 'Оплата через официального бота @PremiumBot — VPN не нужен.',
    },
  },
];

/**
 * Архив витрины (решение владельца 2026-07-02: сузить каталог; 2026-07-07 —
 * дополнительно убраны Netflix / Spotify / YouTube Premium / Zoom). Эти сервисы
 * УБРАНЫ из витрины (is_active=false), но записи сохранены здесь целиком —
 * для восстановления достаточно перенести entry обратно в CATALOG (архивный
 * slug деактивируется автоматически, пока лежит в этом списке). История
 * заказов не трогается: деактивация вместо DELETE.
 */
const ARCHIVED_CATALOG: readonly CatalogEntry[] = [
  // ─── AI ──────────────────────────────────────────────────────────────────
  {
    // Убран из витрины 2026-07-12 (решение владельца).
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

  // ─── Streaming (убраны из витрины 2026-07-07) ────────────────────────────────
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

  // ─── Gaming ────────────────────────────────────────────────────────────────
  {
    slug: 'playstation-plus',
    name: 'PlayStation Plus',
    description: 'Подписка PlayStation Plus: Essential, Extra, Premium',
    category: 'gaming',
    requiresKyc: false,
    pricingPolicy: policy([
      usd('Essential', 10.99),
      usd('Essential', 27.99, 'quarter'),
      usd('Essential', 79.99, 'year'),
      usd('Extra', 16.99),
      usd('Extra', 43.99, 'quarter'),
      usd('Extra', 134.99, 'year'),
      usd('Premium', 19.99),
      usd('Premium', 54.99, 'quarter'),
      usd('Premium', 159.99, 'year'),
    ]),
  },
  {
    slug: 'xbox-game-pass',
    name: 'Xbox Game Pass',
    description: 'Подписки Xbox Game Pass: Essential, Premium, Ultimate, PC',
    category: 'gaming',
    requiresKyc: false,
    pricingPolicy: policy([
      usd('Essential', 9.99),
      usd('Premium', 14.99),
      usd('Ultimate', 22.99),
      usd('PC Game Pass', 13.99),
    ]),
  },
  {
    slug: 'steam',
    name: 'Steam (пополнение)',
    description: 'Пополнение кошелька Steam — сумму вводит клиент',
    category: 'gaming',
    requiresKyc: false,
    pricingPolicy: policy([CUSTOM_AMOUNT_TIER]),
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
  {
    slug: 'booking',
    name: 'Booking.com (бронирование)',
    description: 'Бронирование жилья — индивидуальная цена под каждый заказ',
    category: 'travel',
    requiresKyc: true,
    pricingPolicy: policy([CUSTOM_AMOUNT_TIER]),
  },

  // ─── Productivity ───────────────────────────────────────────────────────────
  {
    // Убран из витрины 2026-07-07 (решение владельца).
    slug: 'zoom-pro',
    name: 'Zoom',
    description: 'Zoom Workplace Pro — видеоконференции',
    category: 'productivity',
    requiresKyc: false,
    pricingPolicy: policy([usd('Pro', 16.99), usd('Pro', 159.96, 'year')]),
  },
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
    slug: 'notion-plus',
    name: 'Notion',
    description: 'Notion — рабочее пространство',
    category: 'productivity',
    requiresKyc: false,
    pricingPolicy: policy([usd('Plus', 12), usd('Business', 24)]),
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

  // ─── Social ──────────────────────────────────────────────────────────────────
  {
    slug: 'tinder',
    name: 'Tinder',
    description: 'Tinder — подписки Plus, Gold, Platinum',
    category: 'social',
    requiresKyc: false,
    pricingPolicy: policy([usd('Plus', 24.99), usd('Gold', 39.99), usd('Platinum', 49.99)]),
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
      // и payment_instructions перед записью в jsonb-колонки.
      const validatedPolicy = pricingPolicy.parse(entry.pricingPolicy);
      // Тарифы обязаны быть различимы ОБОИМИ ключами поиска: `(period,
      // originalAmount)` для кнопки Telegram и `(name, period)` для матчинга
      // заказа в вебе и Mini App. Fail-fast на seed'е, а не тихо в проде.
      assertUniqueTierKeys(entry.slug, validatedPolicy.tiers);
      const validatedInstructions = entry.paymentInstructions
        ? servicePaymentInstructions.parse(entry.paymentInstructions)
        : null;

      await db
        .insert(services)
        .values({
          slug: entry.slug,
          name: entry.name,
          description: entry.description ?? null,
          category: entry.category,
          requiresKyc: entry.requiresKyc,
          pricingPolicy: validatedPolicy,
          paymentInstructions: validatedInstructions,
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
            paymentInstructions: validatedInstructions,
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

    // Деактивация: легаси-дубли + архив витрины (см. ARCHIVED_CATALOG).
    const inactiveSlugs = [...DEPRECATED_SLUGS, ...ARCHIVED_CATALOG.map((e) => e.slug)];
    if (inactiveSlugs.length > 0) {
      const deactivated = await db
        .update(services)
        .set({ isActive: false })
        .where(inArray(services.slug, inactiveSlugs))
        .returning({ slug: services.slug });
      logger.info(
        { slugs: deactivated.map((r) => r.slug) },
        'deprecated/archived services deactivated',
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
