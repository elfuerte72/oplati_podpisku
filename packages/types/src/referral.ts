import { z } from 'zod';

/**
 * Реферальная (партнёрская) программа — таблица ставок, парс реферального кода
 * и обход дерева сети. Источник: referral_rules.docx v1.0 + SPEC.md §3.
 *
 * Упрощение 2026-07-02 (решение владельца): программа ОДНОУРОВНЕВАЯ — партнёр
 * получает процент только с оплат СВОИХ прямых рефералов. Уровни 2–3 и командный
 * множитель удалены из экономики; исторические начисления уровней 2–3 в ledger'е
 * остаются валидными (append-only), просто новых не появляется.
 *
 * Канон ставок — раздел 4 правил («круги», UI-термин «статус»). Worked-пример
 * (см. referral.test.ts): Netflix $15.99 × 4% = $0.64, × 7% = $1.12.
 *
 * Деньги — USD-центы integer (инвариант проекта). Ставки — bps (basis points):
 * 100 bps = 1%. База начисления — orders.original_amount (USD-центы).
 */

// ─── Таблица ставок (источник правды расчёта) ─────────────────────────────

/** Ставка партнёра для одного круга. Все суммы — USD-центы, ставки — bps. */
export type ReferralCircleRates = {
  /** Порог месячного оборота рефералов для входа в круг (USD-центы). 0 = Клиент. */
  readonly thresholdUsdCents: number;
  /** Ставка с оплат прямых рефералов (единственный уровень программы). */
  readonly l1Bps: number;
  /** Разовый бонус за достижение круга (USD-центы). 0 = нет. */
  readonly achievementBonusUsdCents: number;
  readonly label: string;
};

/**
 * Индекс массива = номер круга (0..3). Круг 1 «Старт» фиксирует 4% навсегда —
 * та же ставка, что у Клиента, но «зафиксирована» (храповик, см. Этап C).
 */
export const REFERRAL_RATE_TABLE: readonly ReferralCircleRates[] = [
  { thresholdUsdCents: 0, l1Bps: 400, achievementBonusUsdCents: 0, label: 'Клиент' },
  { thresholdUsdCents: 50_000, l1Bps: 400, achievementBonusUsdCents: 0, label: 'Старт' },
  { thresholdUsdCents: 200_000, l1Bps: 600, achievementBonusUsdCents: 5_000, label: 'Партнёр' },
  { thresholdUsdCents: 500_000, l1Bps: 700, achievementBonusUsdCents: 15_000, label: 'Топ-партнёр' },
] as const;

/** Максимальная глубина сети для начисления (программа одноуровневая). */
export const REFERRAL_MAX_LEVEL = 1;

/** Дефолтный круг для нового партнёра (Клиент). */
export const REFERRAL_DEFAULT_CIRCLE = 0;

/** Нормализует номер круга в валидный индекс таблицы (0..3). */
export function clampCircle(circle: number): number {
  if (!Number.isInteger(circle) || circle < 0) return 0;
  if (circle >= REFERRAL_RATE_TABLE.length) return REFERRAL_RATE_TABLE.length - 1;
  return circle;
}

/**
 * Ставка (bps) для beneficiary данного круга. Единственный начисляемый уровень —
 * 1 (прямой реферер); любой другой → 0 (не начисляем).
 */
export function referralRateBps(circle: number, level: number): number {
  if (level !== 1) return 0;
  return REFERRAL_RATE_TABLE[clampCircle(circle)]?.l1Bps ?? 0;
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
 * БАЗОВАЯ максимальная ставка (bps) БЕЗ модификаторов: Топ-партнёр = 700 bps (7%).
 * С модификатором (Этап C: буст +boostBps) фактическая ставка может быть выше —
 * поэтому рантайм-инвариант «начисление ≤ комиссия заказа» в accrue.ts считает
 * реальную сумму строк, а не эту константу (она — для документации экономики
 * и теста базовой ставки).
 */
export const REFERRAL_MAX_CHAIN_BPS =
  REFERRAL_RATE_TABLE[REFERRAL_RATE_TABLE.length - 1]!.l1Bps;

/**
 * Потолок спринт-буста (bps). Дублировать значение из
 * `referral-progression.ts` нельзя (циклический импорт), поэтому здесь именно
 * ПОТОЛОК: он ограничивает ставку сверху, а не задаёт её.
 */
const MAX_BOOST_BPS = 100;

// ─── Расчёт начислений (чистая логика, экономическое ядро) ─────────────────

/** Параметры одного beneficiary для расчёта commission-начисления. */
export type AccrualBeneficiary = {
  readonly userId: string;
  /** Уровень сети относительно плательщика (в одноуровневой программе всегда 1). */
  readonly level: number;
  /**
   * Зафиксированная ставка партнёра (bps) — ЕДИНСТВЕННЫЙ источник процента
   * (решение владельца 2026-08-11).
   *
   * До этого начисление считалось по текущему статусу (`circle` →
   * `REFERRAL_RATE_TABLE`), а кабинет показывал `locked_rate_l1_bps` — два
   * источника, которые расходятся при любом рассинхроне, и тогда в кабинете
   * одна цифра, а платится другая. Выбрана зафиксированная: «процент не
   * падает» — это то, что партнёру обещано на экране, а храповик ставки уже
   * ведёт `planMonthlyProgression`.
   */
  readonly lockedRateL1Bps: number;
  /** Временный +1% к ставке на текущий месяц (Этап C); 0 если нет. */
  readonly boostBps: number;
};

/** Спланированное начисление (без id/payment — их проставит репозиторий при INSERT). */
export type PlannedAccrual = {
  readonly beneficiaryUserId: string;
  readonly level: number;
  readonly rateBps: number;
  readonly amountUsdCents: number;
};

/**
 * Считает commission-начисления от базы заказа (`original_amount`, USD-центы).
 * Ставка beneficiary = базовая по кругу (только уровень 1) + временный буст.
 * Начисления, схлопнувшиеся в 0 после floor, отбрасываются. Чистая функция —
 * тестируется без БД.
 */
export function planCommissionAccruals(
  baseUsdCents: number,
  beneficiaries: readonly AccrualBeneficiary[],
): PlannedAccrual[] {
  const out: PlannedAccrual[] = [];
  for (const b of beneficiaries) {
    // Один источник ставки на расчёт и на витрину: обе стороны зовут
    // `effectiveReferralRates`. Уровни ≥2 в одноуровневой программе не
    // появляются (`REFERRAL_MAX_LEVEL=1`), исторические строки ledger'а валидны.
    const rateBps =
      b.level === 1
        ? effectiveReferralRates({ lockedRateL1Bps: b.lockedRateL1Bps, boostBps: b.boostBps }).l1Bps
        : 0;
    const amountUsdCents = referralAmountUsdCents(baseUsdCents, rateBps);
    if (amountUsdCents <= 0) continue;
    out.push({ beneficiaryUserId: b.userId, level: b.level, rateBps, amountUsdCents });
  }
  return out;
}

// ─── Эффективная ставка для отображения (кабинет) ─────────────────────────

/** Текущая применяемая ставка партнёра (bps) для показа в кабинете. */
export type EffectiveReferralRates = {
  readonly l1Bps: number;
};

/**
 * Ставка, по которой СЕЙЧАС считается начисление beneficiary.
 *
 * ЕДИНСТВЕННЫЙ источник процента: её зовут и расчёт (`planCommissionAccruals`),
 * и кабинет. До 2026-08-11 расчёт брал ставку из таблицы по текущему статусу, а
 * кабинет — зафиксированную; разъезд означал бы, что партнёр видит одну цифру, а
 * получает другую.
 */
export function effectiveReferralRates(input: {
  lockedRateL1Bps: number;
  boostBps: number;
}): EffectiveReferralRates {
  // Потолок обязателен. Раньше ставка приходила из таблицы по кругу, и она
  // физически не могла превысить максимум; теперь источник — колонка БД, а
  // кривое значение (мисконфиг, ручная правка, будущий баг прогрессии) платило
  // бы из маржи заказа без ограничения (ревью 2026-08-11). Буст (+1%) — часть
  // ставки, поэтому кламп общий: максимум таблицы плюс буст.
  const raw = input.lockedRateL1Bps + (input.boostBps > 0 ? input.boostBps : 0);
  return { l1Bps: Math.max(0, Math.min(raw, REFERRAL_MAX_CHAIN_BPS + MAX_BOOST_BPS)) };
}

// ─── Реферальный код и deep-link ──────────────────────────────────────────

/** Префикс deep-link захвата: `telegram.me/<bot>?start=ref_<code>`. */
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
 * Достаёт реферальный код из payload `/start` бота (`ref_<code>`). Захват
 * реферера идёт ТОЛЬКО через Telegram deep-link (решение 2026-07-02; веб-захват
 * `?ref=` удалён). Невалидный/чужой формат → `null` (захвата нет, это НЕ
 * ошибка — пользователь создаётся без реферера).
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
  /** Уровень относительно стартового: 1 = прямой реферер (единственный начисляемый). */
  readonly level: number;
};

/**
 * Поднимается по дереву `referred_by` от `startUserId` вверх до `maxLevel`
 * предков (в одноуровневой программе дефолт — только прямой реферер).
 * `getParentId` — резолвер родителя (в @oplati/db оборачивает запрос к БД);
 * обрыв на `null`/корне. Защита от циклов (visited-set) — на случай аномалии
 * данных, хотя immutable-referrer их исключает.
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
