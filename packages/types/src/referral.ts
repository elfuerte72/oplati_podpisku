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
 * БАЗОВАЯ суммарная ставка (bps) цепочки для самой «дорогой» конфигурации круга,
 * БЕЗ модификаторов: Топ-партнёр на трёх уровнях = 700 + 200 + 100 = 1000 bps (10%).
 * С модификаторами (Этап C: командный множитель L2 +50, буст L1 +boostBps) фактическая
 * цепочка может быть выше — поэтому рантайм-инвариант «начисление ≤ комиссия заказа»
 * в accrue.ts считает реальную сумму строк, а не эту константу (она — для документации
 * экономики и теста базовой цепочки).
 */
export const REFERRAL_MAX_CHAIN_BPS =
  REFERRAL_RATE_TABLE[REFERRAL_RATE_TABLE.length - 1]!.l1Bps +
  REFERRAL_RATE_TABLE[REFERRAL_RATE_TABLE.length - 1]!.l2Bps +
  REFERRAL_RATE_TABLE[REFERRAL_RATE_TABLE.length - 1]!.l3Bps;

// ─── Расчёт начислений (чистая логика, экономическое ядро) ─────────────────

/** Параметры одного beneficiary для расчёта commission-начисления. */
export type AccrualBeneficiary = {
  readonly userId: string;
  /** Уровень сети относительно плательщика: 1..3. */
  readonly level: number;
  /** Круг партнёра (0..3); 0 если профиля referral_partners ещё нет. */
  readonly circle: number;
  /** 5+ активных рефералов L2 → ставка L2 2%→2.5% (Этап C); иначе false. */
  readonly teamMultiplier: boolean;
  /** Временный +1% к L1 на текущий месяц (Этап C); 0 если нет. */
  readonly boostBps: number;
};

/** Спланированное начисление (без id/payment — их проставит репозиторий при INSERT). */
export type PlannedAccrual = {
  readonly beneficiaryUserId: string;
  readonly level: number;
  readonly rateBps: number;
  readonly amountUsdCents: number;
};

/** Ставка L2 при активном командном множителе: 2% → 2.5%. */
const TEAM_MULTIPLIER_L2_BPS = 250;

/**
 * Считает commission-начисления цепочки от базы заказа (`original_amount`,
 * USD-центы). Ставка beneficiary = базовая по кругу/уровню + командный множитель
 * (только L2 с базой 2%) + временный буст (только L1). Начисления, схлопнувшиеся
 * в 0 после floor, отбрасываются. Чистая функция — тестируется без БД.
 */
export function planCommissionAccruals(
  baseUsdCents: number,
  beneficiaries: readonly AccrualBeneficiary[],
): PlannedAccrual[] {
  const out: PlannedAccrual[] = [];
  for (const b of beneficiaries) {
    let rateBps = referralRateBps(b.circle, b.level);
    if (b.level === 2 && b.teamMultiplier && rateBps === 200) {
      rateBps = TEAM_MULTIPLIER_L2_BPS;
    }
    if (b.level === 1 && b.boostBps > 0) {
      rateBps += b.boostBps;
    }
    const amountUsdCents = referralAmountUsdCents(baseUsdCents, rateBps);
    if (amountUsdCents <= 0) continue;
    out.push({ beneficiaryUserId: b.userId, level: b.level, rateBps, amountUsdCents });
  }
  return out;
}

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

/**
 * Должна ли «выживающая» строка (telegram) унаследовать реферера удаляемой
 * (web) при merge привязки `consumeLinkToken`. True только если у target реферера
 * ещё нет, у source он есть и это не самореферал (source-реферер ≠ target). Чистая
 * логика выделена из транзакции ради тестируемости (packages/db без тест-раннера).
 */
export function shouldInheritReferrerOnMerge(
  targetReferredBy: string | null,
  sourceReferredBy: string | null,
  targetUserId: string,
): boolean {
  return (
    targetReferredBy === null &&
    sourceReferredBy !== null &&
    sourceReferredBy !== targetUserId
  );
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
