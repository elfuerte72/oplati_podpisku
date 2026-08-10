import {
  pricingPolicy,
  servicePaymentInstructions,
  type ServicePaymentInstructions,
} from '@oplati/types';

import { roundUpToWholeRubles } from '@/lib/pricing';

/**
 * Сборка кнопочного каталога веб-чата из строк `services` (решение владельца
 * 2026-06-12: happy path «сервис → тариф → оплата» идёт без AI, источник
 * цены — `pricing_policy.tiers[].originalAmount` в USD-центах).
 *
 * Формула рублёвой цены тарифа — та же, что в `propose_order`
 * (см. lib/tool-handlers/propose-order.ts): subtotal = round(usdCents × rate),
 * commission = round(subtotal × percent / 100),
 * total = ceilToRubles(subtotal + commission).
 * Здесь она даёт ОЦЕНКУ для витрины; юридически значимая сумма фиксируется
 * заново в момент создания заказа.
 */

export type CatalogTier = {
  name: string;
  period: 'month' | 'quarter' | 'year';
  usdCents: number;
  /** Оценка «к оплате» в копейках: курс на момент сборки + комиссия. */
  totalKopecks: number;
};

export type CatalogService = {
  slug: string;
  name: string;
  category: string | null;
  requiresKyc: boolean;
  /** true — фиксированных тарифов нет (Airbnb): клиент вводит сумму сам. */
  customAmount: boolean;
  tiers: CatalogTier[];
  /**
   * Правила оплаты на сайте сервиса (VPN/валюта/billing/ссылка) — ТЗ §5:
   * VPN не показываем общим советом. null — записи нет, витрина показывает
   * generic-подсказку.
   */
  instructions: ServicePaymentInstructions | null;
};

type ServiceRowLike = {
  slug: string;
  name: string;
  category: string | null;
  requiresKyc: boolean;
  pricingPolicy: unknown;
  /** Опционально: строки без записи (и старые фикстуры) дают instructions: null. */
  paymentInstructions?: unknown;
};

/**
 * Dummy-tier с originalAmount ≤ 1 цента — маркер «цена индивидуальная»
 * (так seed обходит .positive() в zod-схеме для Airbnb).
 */
const CUSTOM_AMOUNT_THRESHOLD_USD_CENTS = 1;

export function computeTotalKopecks(
  usdCents: number,
  rate: number,
  commissionPercent: number,
): number {
  const subtotalKopecks = Math.round(usdCents * rate);
  const commissionKopecks = Math.round((subtotalKopecks * commissionPercent) / 100);
  // Цену показываем без копеек, округление вверх — та же функция, что фиксирует
  // сумму заказа в `propose_order` (иначе витрина и заказ разъедутся на рубль).
  return roundUpToWholeRubles(subtotalKopecks + commissionKopecks);
}

/**
 * Преобразует строку каталога в позицию витрины. `null` — сервис показать
 * нельзя: невалидная pricing_policy или ни одного пригодного USD-тарифа
 * (вызывающая сторона логирует).
 *
 * `minOrderKopecks` — пол суммы заказа (`orderFloorRub() × 100`: продуктовый
 * порог 500 ₽ и минимум АКТИВНОГО шлюза, что больше). Тарифы дешевле порога НЕ
 * показываем: их всё равно нельзя оплатить (`below_min_amount`), кнопка-тупик. На
 * custom-amount сервисы (Airbnb) не влияет — там минимум проверяется при вводе
 * суммы в `proposeOrder`.
 */
export function buildCatalogService(
  row: ServiceRowLike,
  rate: number,
  commissionPercent: number,
  minOrderKopecks: number,
): CatalogService | null {
  const parsed = pricingPolicy.safeParse(row.pricingPolicy);
  if (!parsed.success) return null;

  // Инструкции опциональны: битая/отсутствующая запись НЕ прячет сервис —
  // клиент получит generic-подсказку вместо пер-сервисной.
  const parsedInstructions = servicePaymentInstructions.safeParse(row.paymentInstructions);

  const base = {
    slug: row.slug,
    name: row.name,
    category: row.category,
    requiresKyc: row.requiresKyc,
    instructions: parsedInstructions.success ? parsedInstructions.data : null,
  };

  const allDummy = parsed.data.tiers.every(
    (t) => (t.originalAmount ?? 0) <= CUSTOM_AMOUNT_THRESHOLD_USD_CENTS,
  );
  if (allDummy) {
    return { ...base, customAmount: true, tiers: [] };
  }

  const tiers: CatalogTier[] = parsed.data.tiers
    .filter(
      (t) =>
        t.currency === 'USD' &&
        typeof t.originalAmount === 'number' &&
        t.originalAmount > CUSTOM_AMOUNT_THRESHOLD_USD_CENTS,
    )
    .map((t) => ({
      name: t.name,
      period: t.period,
      // filter выше гарантирует number, но noUncheckedIndexedAccess-стиль честнее
      usdCents: t.originalAmount ?? 0,
      totalKopecks: computeTotalKopecks(t.originalAmount ?? 0, rate, commissionPercent),
    }))
    // Тарифы ниже пола терминала L&P не показываем — их нельзя оплатить.
    .filter((t) => t.totalKopecks >= minOrderKopecks);

  if (tiers.length === 0) return null;
  return { ...base, customAmount: false, tiers };
}

/**
 * Порядок витрины: сперва самые ходовые (решение владельца — список в коде),
 * остальные по алфавиту.
 */
const POPULAR_ORDER: readonly string[] = [
  'chatgpt-plus',
  'claude-pro',
  'spotify-premium',
  'netflix-premium',
  'youtube-premium',
  'apple-app-store',
  'discord-nitro',
  'playstation-plus',
  'xbox-game-pass',
  'steam',
  'midjourney-basic',
  'apple-music',
];

export function sortCatalog(items: CatalogService[]): CatalogService[] {
  return [...items].sort((a, b) => {
    const ai = POPULAR_ORDER.indexOf(a.slug);
    const bi = POPULAR_ORDER.indexOf(b.slug);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.name.localeCompare(b.name, 'ru');
  });
}

/**
 * Темы каталога: русские заголовки секций и порядок показа (решение владельца
 * 2026-06-29 — список разбит на темы, чтобы не висел сплошной стеной кнопок).
 * Ключ — `services.category`. Категории вне списка падают в хвост по алфавиту
 * под собственным (английским) именем — это сигнал «забыли завести label».
 */
export const CATEGORY_LABELS: Record<string, string> = {
  ai: 'Искусственный интеллект',
  streaming: 'Стриминг и музыка',
  gaming: 'Игры',
  productivity: 'Сервисы и работа',
  social: 'Общение',
  travel: 'Путешествия',
};

const CATEGORY_ORDER: readonly string[] = [
  'ai',
  'streaming',
  'gaming',
  'productivity',
  'social',
  'travel',
];

export type CatalogGroup = {
  category: string;
  label: string;
  services: CatalogService[];
};

/**
 * Сервисы, которые полностью настроены и остаются в seed/БД, но временно не
 * показываются пользователям ни в веб-каталоге, ни в Mini App, ни в меню бота.
 * Внутренний lookup по slug не фильтруется: существующие заказы и уже
 * отправленные Telegram-кнопки продолжают работать.
 */
const HIDDEN_CATALOG_SLUGS = new Set([
  'apple-music',
  'apple-app-store',
  'icloud-plus-200gb',
  'telegram-premium',
]);

export function filterCatalogForDisplay(items: CatalogService[]): CatalogService[] {
  return items.filter((service) => !HIDDEN_CATALOG_SLUGS.has(service.slug));
}

/**
 * Группирует каталог по темам в порядке `CATEGORY_ORDER`; внутри темы порядок —
 * как у `sortCatalog` (популярные вперёд, дальше алфавит). Пустые темы
 * пропускаются. Неизвестные категории — в конце, по алфавиту.
 */
export function groupCatalog(items: CatalogService[]): CatalogGroup[] {
  const byCategory = new Map<string, CatalogService[]>();
  for (const svc of sortCatalog(items)) {
    const category = svc.category ?? 'other';
    const bucket = byCategory.get(category);
    if (bucket) bucket.push(svc);
    else byCategory.set(category, [svc]);
  }

  const groups: CatalogGroup[] = [];
  for (const category of CATEGORY_ORDER) {
    const services = byCategory.get(category);
    if (services && services.length > 0) {
      groups.push({ category, label: CATEGORY_LABELS[category] ?? category, services });
      byCategory.delete(category);
    }
  }
  for (const [category, services] of [...byCategory.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    groups.push({ category, label: CATEGORY_LABELS[category] ?? category, services });
  }
  return groups;
}
