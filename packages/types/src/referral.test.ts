import { describe, expect, it } from 'vitest';

import {
  parseReferralCode,
  referralAmountUsdCents,
  referralRateBps,
  shouldInheritReferrerOnMerge,
  REFERRAL_MAX_CHAIN_BPS,
  REFERRAL_RATE_TABLE,
  walkReferralAncestors,
  type ReferralAncestor,
} from './referral.ts';

describe('REFERRAL_RATE_TABLE — воспроизводит worked-примеры правил и мокапа', () => {
  // Док: «клиент оплатил Netflix $15.99 — партнёр-Клиент получает $0.64,
  // партнёр-Топ получает $1.12». $15.99 = 1599 USD-центов.
  it('Netflix $15.99 × 4% (Клиент L1) = $0.64', () => {
    expect(referralAmountUsdCents(1599, referralRateBps(0, 1))).toBe(63); // floor(63.96) = 63 центов
  });

  it('Netflix $15.99 × 7% (Топ L1) = $1.11..$1.12', () => {
    expect(referralAmountUsdCents(1599, referralRateBps(3, 1))).toBe(111); // floor(111.93)
  });

  // Мокап: Ур.1 Netflix (Круг 2 «Партнёр», 6%) = +$0.96; Ур.2 Spotify 2% = +$0.20.
  it('Мокап: Netflix $15.99 × 6% (Круг 2 L1) = $0.95', () => {
    expect(referralAmountUsdCents(1599, referralRateBps(2, 1))).toBe(95); // floor(95.94)
  });

  it('Мокап: Spotify $9.99 × 2% (Круг 2 L2) = $0.19', () => {
    expect(referralAmountUsdCents(999, referralRateBps(2, 2))).toBe(19); // floor(19.98)
  });

  it('Мокап: ChatGPT $20.00 × 6% (Круг 2 L1) = $1.20', () => {
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

  it('инвариант экономики: макс. цепочка = 10% (≤ комиссия 30%)', () => {
    expect(REFERRAL_MAX_CHAIN_BPS).toBe(1000);
  });
});

describe('referralRateBps — границы', () => {
  it('уровень вне 1..3 → 0', () => {
    expect(referralRateBps(2, 0)).toBe(0);
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
  it('принимает голый код (?ref=)', () => {
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

describe('walkReferralAncestors — обход дерева до 3 уровней', () => {
  // Дерево: pyotr → ivan → maria → alexey (alexey — корень, без реферера).
  const parents: Record<string, string | null> = {
    pyotr: 'ivan',
    ivan: 'maria',
    maria: 'alexey',
    alexey: null,
  };
  const getParent = async (id: string) => parents[id] ?? null;

  it('от pyotr находит 3 предков с корректными уровнями', async () => {
    const ancestors = await walkReferralAncestors(getParent, 'pyotr', 3);
    expect(ancestors).toEqual<ReferralAncestor[]>([
      { userId: 'ivan', level: 1 },
      { userId: 'maria', level: 2 },
      { userId: 'alexey', level: 3 },
    ]);
  });

  it('обрывается на корне (меньше 3 уровней)', async () => {
    const ancestors = await walkReferralAncestors(getParent, 'maria', 3);
    expect(ancestors).toEqual<ReferralAncestor[]>([{ userId: 'alexey', level: 1 }]);
  });

  it('пользователь без реферера → пустой список', async () => {
    const ancestors = await walkReferralAncestors(getParent, 'alexey', 3);
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
