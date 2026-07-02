import { describe, expect, it } from 'vitest';

import {
  effectiveReferralRates,
  parseReferralCode,
  planCommissionAccruals,
  referralAmountUsdCents,
  referralRateBps,
  shouldInheritReferrerOnMerge,
  REFERRAL_MAX_CHAIN_BPS,
  REFERRAL_MAX_LEVEL,
  REFERRAL_RATE_TABLE,
  walkReferralAncestors,
  type AccrualBeneficiary,
  type PlannedAccrual,
  type ReferralAncestor,
} from './referral.ts';

const benef = (over: Partial<AccrualBeneficiary> & Pick<AccrualBeneficiary, 'userId' | 'level'>): AccrualBeneficiary => ({
  circle: 0,
  boostBps: 0,
  ...over,
});

describe('REFERRAL_RATE_TABLE — воспроизводит worked-примеры правил и мокапа', () => {
  // Док: «клиент оплатил Netflix $15.99 — партнёр-Клиент получает $0.64,
  // партнёр-Топ получает $1.12». $15.99 = 1599 USD-центов.
  it('Netflix $15.99 × 4% (Клиент) = $0.64', () => {
    expect(referralAmountUsdCents(1599, referralRateBps(0, 1))).toBe(63); // floor(63.96) = 63 центов
  });

  it('Netflix $15.99 × 7% (Топ) = $1.11..$1.12', () => {
    expect(referralAmountUsdCents(1599, referralRateBps(3, 1))).toBe(111); // floor(111.93)
  });

  it('Мокап: Netflix $15.99 × 6% (Круг 2) = $0.95', () => {
    expect(referralAmountUsdCents(1599, referralRateBps(2, 1))).toBe(95); // floor(95.94)
  });

  it('Мокап: ChatGPT $20.00 × 6% (Круг 2) = $1.20', () => {
    expect(referralAmountUsdCents(2000, referralRateBps(2, 1))).toBe(120);
  });

  it('таблица содержит 4 круга с порогами $0/$500/$2000/$5000', () => {
    expect(REFERRAL_RATE_TABLE.map((r) => r.thresholdUsdCents)).toEqual([
      0, 50_000, 200_000, 500_000,
    ]);
  });

  it('бонусы достижения круга: $0/$0/$50/$150', () => {
    expect(REFERRAL_RATE_TABLE.map((r) => r.achievementBonusUsdCents)).toEqual([
      0, 0, 5_000, 15_000,
    ]);
  });

  it('программа одноуровневая: глубина 1, макс. ставка 7% (≤ комиссия 30%)', () => {
    expect(REFERRAL_MAX_LEVEL).toBe(1);
    expect(REFERRAL_MAX_CHAIN_BPS).toBe(700);
  });
});

describe('referralRateBps — границы', () => {
  it('любой уровень, кроме 1 → 0 (уровни 2–3 удалены из программы)', () => {
    expect(referralRateBps(2, 0)).toBe(0);
    expect(referralRateBps(2, 2)).toBe(0);
    expect(referralRateBps(3, 3)).toBe(0);
    expect(referralRateBps(2, 4)).toBe(0);
  });

  it('круг вне диапазона клампится (не падает)', () => {
    expect(referralRateBps(99, 1)).toBe(referralRateBps(3, 1));
    expect(referralRateBps(-1, 1)).toBe(referralRateBps(0, 1));
  });
});

describe('referralAmountUsdCents — floor, без отрицательных', () => {
  it('округляет вниз', () => {
    expect(referralAmountUsdCents(1599, 400)).toBe(63);
  });
  it('ноль/отрицательная база или ставка → 0', () => {
    expect(referralAmountUsdCents(0, 400)).toBe(0);
    expect(referralAmountUsdCents(1000, 0)).toBe(0);
    expect(referralAmountUsdCents(-100, 400)).toBe(0);
  });
});

describe('parseReferralCode', () => {
  it('достаёт код из deep-link payload ref_<code>', () => {
    expect(parseReferralCode('ref_ab12cd34')).toBe('ab12cd34');
  });
  it('принимает голый код', () => {
    expect(parseReferralCode('ab12cd34')).toBe('ab12cd34');
  });
  it('нормализует регистр и пробелы', () => {
    expect(parseReferralCode('  REF_AB12CD34  ')).toBe('ab12cd34');
  });
  it('пустой/невалидный/чужой формат → null', () => {
    expect(parseReferralCode(null)).toBeNull();
    expect(parseReferralCode('')).toBeNull();
    expect(parseReferralCode('ref_')).toBeNull();
    expect(parseReferralCode('link_xyz')).toBeNull(); // другой deep-link
    expect(parseReferralCode('ref_!!bad!!')).toBeNull();
    expect(parseReferralCode('ab')).toBeNull(); // слишком короткий
  });
});

describe('planCommissionAccruals — расчёт начислений (один уровень)', () => {
  it('Топ-партнёр (круг 3), база $20 → 7%', () => {
    const rows = planCommissionAccruals(2000, [benef({ userId: 'l1', level: 1, circle: 3 })]);
    expect(rows).toEqual<PlannedAccrual[]>([
      { beneficiaryUserId: 'l1', level: 1, rateBps: 700, amountUsdCents: 140 },
    ]);
  });

  it('уровни 2–3 не начисляются (ставка 0 → строки нет)', () => {
    const rows = planCommissionAccruals(2000, [
      benef({ userId: 'l1', level: 1, circle: 3 }),
      benef({ userId: 'l2', level: 2, circle: 3 }),
      benef({ userId: 'l3', level: 3, circle: 3 }),
    ]);
    expect(rows).toEqual<PlannedAccrual[]>([
      { beneficiaryUserId: 'l1', level: 1, rateBps: 700, amountUsdCents: 140 },
    ]);
  });

  it('временный буст +1% применяется к прямому рефереру', () => {
    const rows = planCommissionAccruals(2000, [
      benef({ userId: 'l1', level: 1, circle: 2, boostBps: 100 }),
    ]);
    expect(rows[0]?.rateBps).toBe(700); // 6% + 1% буст
  });

  it('начисление, схлопнувшееся в 0 после floor, отбрасывается', () => {
    // База 1 цент × 4% = 0.04 цента → floor 0 → нет строки.
    const rows = planCommissionAccruals(1, [benef({ userId: 'l1', level: 1, circle: 0 })]);
    expect(rows).toEqual([]);
  });

  it('пустой список beneficiaries → пустой результат', () => {
    expect(planCommissionAccruals(2000, [])).toEqual([]);
  });

  it('инвариант: максимальная базовая ставка = 7% (без модификаторов)', () => {
    const rows = planCommissionAccruals(100_000, [benef({ userId: 'l1', level: 1, circle: 3 })]);
    const totalBps = rows.reduce((s, r) => s + r.rateBps, 0);
    expect(totalBps).toBe(REFERRAL_MAX_CHAIN_BPS); // 700 = 7%
  });
});

describe('shouldInheritReferrerOnMerge — наследование реферера при merge привязки', () => {
  it('наследует, если у target реферера нет, а у source есть', () => {
    expect(shouldInheritReferrerOnMerge(null, 'referrer-x', 'tg-row')).toBe(true);
  });
  it('НЕ наследует, если у target уже есть реферер (immutable)', () => {
    expect(shouldInheritReferrerOnMerge('existing', 'referrer-x', 'tg-row')).toBe(false);
  });
  it('НЕ наследует, если у source реферера нет', () => {
    expect(shouldInheritReferrerOnMerge(null, null, 'tg-row')).toBe(false);
  });
  it('НЕ наследует самореферал (source-реферер === target)', () => {
    expect(shouldInheritReferrerOnMerge(null, 'tg-row', 'tg-row')).toBe(false);
  });
});

describe('walkReferralAncestors — обход дерева', () => {
  // Дерево: pyotr → ivan → maria → alexey (alexey — корень, без реферера).
  const parents: Record<string, string | null> = {
    pyotr: 'ivan',
    ivan: 'maria',
    maria: 'alexey',
    alexey: null,
  };
  const getParent = async (id: string) => parents[id] ?? null;

  it('дефолтная глубина = REFERRAL_MAX_LEVEL: только прямой реферер', async () => {
    const ancestors = await walkReferralAncestors(getParent, 'pyotr');
    expect(ancestors).toEqual<ReferralAncestor[]>([{ userId: 'ivan', level: 1 }]);
  });

  it('явная глубина 3 находит 3 предков с корректными уровнями (generic-обход)', async () => {
    const ancestors = await walkReferralAncestors(getParent, 'pyotr', 3);
    expect(ancestors).toEqual<ReferralAncestor[]>([
      { userId: 'ivan', level: 1 },
      { userId: 'maria', level: 2 },
      { userId: 'alexey', level: 3 },
    ]);
  });

  it('обрывается на корне', async () => {
    const ancestors = await walkReferralAncestors(getParent, 'maria', 3);
    expect(ancestors).toEqual<ReferralAncestor[]>([{ userId: 'alexey', level: 1 }]);
  });

  it('пользователь без реферера → пустой список', async () => {
    const ancestors = await walkReferralAncestors(getParent, 'alexey');
    expect(ancestors).toEqual([]);
  });

  it('не уходит глубже maxLevel', async () => {
    const ancestors = await walkReferralAncestors(getParent, 'pyotr', 2);
    expect(ancestors.map((a) => a.userId)).toEqual(['ivan', 'maria']);
  });

  it('защита от цикла: не зацикливается на аномальных данных', async () => {
    const cyclic: Record<string, string | null> = { a: 'b', b: 'a' };
    const ancestors = await walkReferralAncestors(
      async (id) => cyclic[id] ?? null,
      'a',
      3,
    );
    // a→b (level 1), затем b→a уже visited → стоп.
    expect(ancestors).toEqual<ReferralAncestor[]>([{ userId: 'b', level: 1 }]);
  });
});

describe('effectiveReferralRates — ставка кабинета = ставка начисления', () => {
  it('круг 2 (Партнёр): 6% без модификаторов', () => {
    expect(effectiveReferralRates({ lockedRateL1Bps: 600, boostBps: 0 })).toEqual({ l1Bps: 600 });
  });

  it('буст +1% прибавляется к ставке', () => {
    expect(effectiveReferralRates({ lockedRateL1Bps: 600, boostBps: 100 }).l1Bps).toBe(700);
  });

  it('храповик: locked-ставка берётся из профиля, не из таблицы круга', () => {
    // Партнёр на круге 1, но с зафиксированной 6% (исторически выше) — показываем фикс.
    expect(effectiveReferralRates({ lockedRateL1Bps: 600, boostBps: 0 }).l1Bps).toBe(600);
  });

  it('совпадает с planCommissionAccruals для той же конфигурации', () => {
    // Конфиг: круг 2, буст +1%. База $100.
    const rates = effectiveReferralRates({ lockedRateL1Bps: 600, boostBps: 100 });
    const planned = planCommissionAccruals(10_000, [
      { userId: 'l1', level: 1, circle: 2, boostBps: 100 },
    ]);
    expect(planned.map((p) => p.rateBps)).toEqual([rates.l1Bps]);
  });
});
