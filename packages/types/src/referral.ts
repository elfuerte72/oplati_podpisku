import { z } from 'zod';

/**
 * Реферальная (партнёрская) программа — таблица ставок, парс реферального кода
 * и обход дерева сети. Источник: referral_rules.docx v1.0 + SPEC.md §3.
 *
 * Канон ставок — раздел 4 правил («круги»). Таблица воспроизводит worked-примеры
 * самого документа и мокапа (см. referral.test.ts): Netflix $15.99 × 4% = $0.64,
 * × 7% = $1.12, и т.д. — то есть значения не догадка, а проверяемый факт.
 *
 * Деньги — USD-центы integer (инвариант проекта). Ставки — bps (basis points):
 * 100 bps = 1%. База начисления — orders.original_amount (USD-центы).
 */

// ─── Таблица ставок (источник правды расчёта) ─────────────────────────────

/** Ставки уровней сети для одного круга. Все суммы — USD-центы, ставки — bps. */
export type ReferralCircleRates = {
  /** Порог месячного оборота сети для входа в круг (USD-центы). 0 = Клиент. */
  readonly thresholdUsdCents: number;
  readonly l1Bps: number;
  readonly l2Bps: number;
  readonly l3Bps: number;
  /** Разовый бонус за достижение круга (USD-центы). 0 = нет. */
  readonly achievementBonusUsdCents: number;
  readonly label: string;
};

/**
 * Индекс массива = номер круга (0..3). Круг 1 «Старт» фиксирует 4% навсегда —
 * та же ставка L1, что у Клиента, но «зафиксирована» (храповик, см. Этап C).
 * L2/L3 берутся из раздела 3 правил, привязанные к кругу.
 */
export const REFERRAL_RATE_TABLE: readonly ReferralCircleRates[] = [
  { thresholdUsdCents: 0, l1Bps: 400, l2Bps: 150, l3Bps: 50, achievementBonusUsdCents: 0, label: 'Клиент' },
  { thresholdUsdCents: 50_000, l1Bps: 400, l2Bps: 150, l3Bps: 50, achievementBonusUsdCents: 0, label: 'Старт' },
  { thresholdUsdCents: 200_000, l1Bps: 600, l2Bps: 200, l3Bps: 100, achievementBonusUsdCents: 5_000, label: 'Партнёр' },
  { thresholdUsdCents: 500_000, l1Bps: 700, l2Bps: 200, l3Bps: 100, achievementBonusUsdCents: 15_000, label: 'Топ-партнёр' },
] as const;

/** Максимальная глубина сети для начисления. */
export const REFERRAL_MAX_LEVEL = 3;

/** Дефолтный круг для нового партнёра (Клиент). */
export const REFERRAL_DEFAULT_CIRCLE = 0;

/** Нормализует номер круга в валидный индекс таблицы (0..3). */
export function clampCircle(circle: number): number {
  if (!Number.isInteger(circle) || circle < 0) return 0;
  if (circle >= REFERRAL_RATE_TABLE.length) return REFERRAL_RATE_TABLE.length - 1;
  return circle;
}

/**
 * Ставка (bps) для beneficiary данного круга на данном уровне сети (1..3).
 * Уровень вне 1..3 → 0 (не начисляем).
 */
export function referralRateBps(circle: number, level: number): number {
  const row = REFERRAL_RATE_TABLE[clampCircle(circle)];
  if (!row) return 0;
  switch (level) {
    case 1:
      return row.l1Bps;
    case 2:
      return row.l2Bps;
    case 3:
      return row.l3Bps;
    default:
      return 0;
  }
}

/**
 * Начисление (USD-центы) с округлением ВНИЗ (floor) — не переплачиваем партнёру
 * долю цента. `baseUsdCents` — original_amount заказа (USD-центы).
 */
export function referralAmountUsdCents(baseUsdCents: number, rateBps: number): number {
  if (baseUsdCents <= 0 || rateBps <= 0) return 0;
  return Math.floor((baseUsdCents * rateBps) / 10_000);
}

/**
 * Суммарная ставка (bps) всей цепочки начисления для самой «дорогой» конфигурации
 * круга — для проверки инварианта «начисление ≤ комиссия заказа». Топ-партнёр
 * на всех трёх уровнях = 700 + 200 + 100 = 1000 bps (10%).
 */
export const REFERRAL_MAX_CHAIN_BPS =
  REFERRAL_RATE_TABLE[REFERRAL_RATE_TABLE.length - 1]!.l1Bps +
  REFERRAL_RATE_TABLE[REFERRAL_RATE_TABLE.length - 1]!.l2Bps +
  REFERRAL_RATE_TABLE[REFERRAL_RATE_TABLE.length - 1]!.l3Bps;

// ─── Реферальный код и deep-link ──────────────────────────────────────────

/** Префикс deep-link захвата: `t.me/<bot>?start=ref_<code>`. */
export const REFERRAL_DEEPLINK_PREFIX = 'ref_';

/**
 * Формат реферального кода. Генератор (в @oplati/db) выдаёт Crockford-base32
 * lowercase без неоднозначных символов; здесь — валидатор на чтение (принимаем
 * любой код этого формата).
 */
export const referralCodeSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.string().regex(/^[0-9a-z]{6,16}$/, 'invalid referral code'));

export type ReferralCode = z.infer<typeof referralCodeSchema>;

/**
 * Достаёт реферальный код из payload `/start` бота (`ref_<code>`) или из значения
 * `?ref=` веба (просто `<code>`). Невалидный/чужой формат → `null` (захвата нет,
 * это НЕ ошибка — пользователь создаётся без реферера).
 */
export function parseReferralCode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // Нормализуем ДО снятия префикса: payload может прийти с регистром/пробелами
  // (`  REF_AbC  `), а префикс `ref_` мы хотим распознать в любом регистре.
  const normalized = raw.trim().toLowerCase();
  const stripped = normalized.startsWith(REFERRAL_DEEPLINK_PREFIX)
    ? normalized.slice(REFERRAL_DEEPLINK_PREFIX.length)
    : normalized;
  const parsed = referralCodeSchema.safeParse(stripped);
  return parsed.success ? parsed.data : null;
}

// ─── Обход дерева сети (чистая логика, БД-агностичная) ─────────────────────

export type ReferralAncestor = {
  /** id предка-партнёра. */
  readonly userId: string;
  /** Уровень относительно стартового: 1 = прямой реферер, 2 = его реферер, 3 = ещё выше. */
  readonly level: number;
};

/**
 * Поднимается по дереву `referred_by` от `startUserId` вверх до `maxLevel`
 * предков. `getParentId` — резолвер родителя (в @oplati/db оборачивает запрос к
 * БД); обрыв на `null`/корне. Защита от циклов (visited-set) — на случай
 * аномалии данных, хотя immutable-referrer их исключает.
 */
export async function walkReferralAncestors(
  getParentId: (userId: string) => Promise<string | null>,
  startUserId: string,
  maxLevel: number = REFERRAL_MAX_LEVEL,
): Promise<ReferralAncestor[]> {
  const ancestors: ReferralAncestor[] = [];
  const visited = new Set<string>([startUserId]);
  let current = startUserId;

  for (let level = 1; level <= maxLevel; level++) {
    const parent = await getParentId(current);
    if (parent === null || visited.has(parent)) break;
    ancestors.push({ userId: parent, level });
    visited.add(parent);
    current = parent;
  }

  return ancestors;
}
