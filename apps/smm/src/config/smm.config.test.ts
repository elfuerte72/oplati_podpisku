import { describe, expect, it } from 'vitest';

import {
  LAYOUT_KEYS,
  MODEL_ROLES,
  RUBRIC_KEYS,
  layoutFor,
  modelPriceUsd,
  smmConfig,
} from './smm.config.ts';

describe('smmConfig', () => {
  it('доли рубрик складываются в единицу', () => {
    // План 35/25/20/10/10 — решение владельца 06.09. Дефицит рубрик считается от
    // этих долей: сумма 0.9 тихо занижала бы дефицит каждой.
    const sum = RUBRIC_KEYS.reduce((acc, key) => acc + smmConfig.rubrics[key].share, 0);
    expect(sum).toBeCloseTo(1, 5);
  });

  it('у каждой рубрики есть раскладка из списка', () => {
    for (const key of RUBRIC_KEYS) {
      const rubric = smmConfig.rubrics[key];
      expect(LAYOUT_KEYS).toContain(rubric.layout);
    }
  });

  it('границы длины раскладки не вывернуты', () => {
    for (const key of LAYOUT_KEYS) {
      const layout = smmConfig.layouts[key];
      expect(layout.minChars).toBeGreaterThan(0);
      expect(layout.maxChars).toBeGreaterThan(layout.minChars);
      expect(layout.skeleton.length).toBeGreaterThan(0);
    }
  });

  it('короткая новость уходит classic, разбор и сравнение — rich', () => {
    // Витрина t.me/s и Telegram Web rich не рендерят: новость обязана быть видна
    // везде, у разбора структура важнее охвата Web (design.md §7).
    expect(layoutFor('news').format).toBe('classic');
    expect(layoutFor('price').format).toBe('rich');
    expect(layoutFor('choice').format).toBe('rich');
  });

  it('пороги линта совпадают с правилами канала', () => {
    const lint = smmConfig.lint;
    expect(lint.paragraphMaxChars).toBe(350);
    expect(lint.paragraphWarnChars).toBe(280);
    expect(lint.wallMinParagraphs).toBe(3);
    expect(lint.wallMaxChars).toBe(600);
    expect(lint.numbersPerParagraph).toBe(3);
    expect(lint.emojiMax).toBe(3);
    expect(lint.tableMaxCols).toBe(3);
    expect(lint.tableMaxRows).toBe(5);
    expect(lint.specialBlocksMax).toBe(1);
    expect(lint.freshnessWindow).toBe(5);
    expect(lint.stockPhrases.length).toBeGreaterThan(10);
  });

  it('политика рекламы: потолок hard и запрет двух подряд', () => {
    expect(smmConfig.ads.hardMaxShare).toBeCloseTo(0.4, 5);
    expect(smmConfig.ads.noTwoHardInARow).toBe(true);
    expect(smmConfig.ads.minHistoryForShare).toBeGreaterThanOrEqual(5);
  });

  it('критерии судьи заданы для обеих площадок и с порогами', () => {
    expect(smmConfig.judge.telegram.criteria.length).toBe(7);
    expect(smmConfig.judge.threads.criteria.length).toBeGreaterThanOrEqual(7);
    expect(smmConfig.judge.passMean).toBe(4);
    expect(smmConfig.judge.minScore).toBe(3);
    expect(smmConfig.judge.maxRounds).toBe(2);
    for (const c of smmConfig.judge.telegram.criteria) {
      expect(c.description.length).toBeGreaterThan(20);
    }
  });

  it('набор критериев судьи описан ключами, а не позицией в массиве', () => {
    // Критерии Threads переиспользуют критерии канала: вставка одного критерия
    // в список канала не должна молча менять набор для Threads.
    expect(smmConfig.judge.telegram.criteria.map((c) => c.key)).toEqual([
      'so_what',
      'voice',
      'clarity',
      'headline',
      'structure',
      'facts',
      'texture',
    ]);
    expect(smmConfig.judge.threads.criteria.map((c) => c.key)).toEqual([
      'hook',
      'so_what',
      'voice',
      'density',
      'clarity',
      'facts',
      'texture',
      'conversation',
    ]);
  });

  it('у каждой роли модели объявлен файл промпта', () => {
    const names = MODEL_ROLES.map((role) => smmConfig.prompts[role]);
    expect(names.every((name) => name.endsWith('.md'))).toBe(true);
    expect(new Set(names).size).toBe(names.length);
  });

  it('лимиты Threads — из правил площадки', () => {
    const t = smmConfig.threads;
    expect(t.pieceLimit).toBe(480);
    expect(t.emojiWeight).toBe(4);
    expect(t.maxPieces).toBe(5);
    expect(t.hookMax).toBe(120);
    expect(t.intentBase).toBe('https://www.threads.com/intent/post');
    expect(t.intentUrlMax).toBe(4000);
  });

  it('у каждой роли модели есть температура, потолок токенов и источник модели', () => {
    for (const role of MODEL_ROLES) {
      const cfg = smmConfig.roles[role];
      expect(cfg.temperature).toBeGreaterThanOrEqual(0);
      expect(cfg.temperature).toBeLessThanOrEqual(1);
      expect(cfg.maxTokens).toBeGreaterThan(100);
      expect(cfg.timeoutMs).toBeGreaterThanOrEqual(20_000);
      expect(['writer', 'judge', 'rank']).toContain(cfg.model);
    }
    // Судья и разбор фактов обязаны быть детерминированы.
    expect(smmConfig.roles.judge.temperature).toBe(0);
    expect(smmConfig.roles.dossier.temperature).toBe(0);
    expect(smmConfig.roles.rank.temperature).toBe(0);
  });

  it('пик тарифа считается по UTC и только в рабочие дни', () => {
    // Вторник 02:00 UTC — пик, тот же вторник 12:00 — нет, суббота 02:00 — нет.
    const peak = modelPriceUsd('deepseek-flash', new Date('2026-09-22T02:30:00Z'));
    const offPeak = modelPriceUsd('deepseek-flash', new Date('2026-09-22T12:00:00Z'));
    const weekend = modelPriceUsd('deepseek-flash', new Date('2026-09-26T02:30:00Z'));
    expect(peak.inputPerMillion).toBeCloseTo(offPeak.inputPerMillion * 2, 6);
    expect(peak.outputPerMillion).toBeCloseTo(offPeak.outputPerMillion * 2, 6);
    expect(weekend.inputPerMillion).toBeCloseTo(offPeak.inputPerMillion, 6);
  });

  it('границы пиковых окон включают начало и не включают конец', () => {
    const base = modelPriceUsd('deepseek-flash', new Date('2026-09-22T12:00:00Z'));
    const at01 = modelPriceUsd('deepseek-flash', new Date('2026-09-22T01:00:00Z'));
    const at04 = modelPriceUsd('deepseek-flash', new Date('2026-09-22T04:00:00Z'));
    const at0959 = modelPriceUsd('deepseek-flash', new Date('2026-09-22T09:59:59Z'));
    expect(at01.inputPerMillion).toBeCloseTo(base.inputPerMillion * 2, 6);
    expect(at04.inputPerMillion).toBeCloseTo(base.inputPerMillion, 6);
    expect(at0959.inputPerMillion).toBeCloseTo(base.inputPerMillion * 2, 6);
  });

  it('незнакомая модель не роняет учёт, а считается по тарифу по умолчанию', () => {
    // Смена модели — правка env; неизвестный тариф не должен превращать
    // публикацию поста в исключение посреди конвейера.
    const price = modelPriceUsd('deepseek-v4-pro', new Date('2026-09-22T12:00:00Z'));
    expect(price.inputPerMillion).toBeGreaterThan(0);
    expect(price.outputPerMillion).toBeGreaterThan(0);
  });

  it('кнопка бота ведёт в клиентского бота с меткой канала', () => {
    expect(smmConfig.buttons.bot.url).toBe('https://t.me/oplatishkaa_bot?start=channel');
    expect(smmConfig.buttons.bot.text.length).toBeGreaterThan(3);
  });

  it('окно тикера источников — рабочие часы МСК', () => {
    expect(smmConfig.sources.pollWindowMsk.fromHour).toBe(9);
    expect(smmConfig.sources.pollWindowMsk.toHour).toBe(22);
    expect(smmConfig.sources.pollEveryHours).toBe(2);
    expect(smmConfig.sources.cacheHours).toBe(12);
  });
});
