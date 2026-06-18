import { pricingPolicy } from '@oplati/types';

/**
 * Сборка кнопочного каталога веб-чата из строк `services` (решение владельца
 * 2026-06-12: happy path «сервис → тариф → оплата» идёт без AI, источник
 * цены — `pricing_policy.tiers[].originalAmount` в USD-центах).
 *
 * Формула рублёвой цены тарифа — та же, что в `propose_order`
 * (см. lib/tool-handlers/propose-order.ts): subtotal = round(usdCents × rate),
 * commission = round(subtotal × percent / 100), total = subtotal + commission.
 * Здесь она даёт ОЦЕНКУ для витрины; юридически значимая сумма фиксируется
 * заново в момент создания заказа.
 */

export type CatalogTier = {
  name: string;
  period: 'month' | 'year';
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
};

type ServiceRowLike = {
  slug: string;
  name: string;
  category: string | null;
  requiresKyc: boolean;
  pricingPolicy: unknown;
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
  return subtotalKopecks + commissionKopecks;
}

/**
 * Преобразует строку каталога в позицию витрины. `null` — сервис показать
 * нельзя: невалидная pricing_policy или ни одного пригодного USD-тарифа
 * (вызывающая сторона логирует).
 *
 * `minOrderKopecks` — пол суммы заказа у платёжного терминала L&P
 * (`LOVEANDPAY_MIN_AMOUNT_RUB × 100`). Тарифы дешевле порога НЕ показываем:
 * их всё равно нельзя оплатить (`below_min_amount`), кнопка-тупик. На
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

  const base = {
    slug: row.slug,
    name: row.name,
    category: row.category,
    requiresKyc: row.requiresKyc,
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
  'discord-nitro',
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
