import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Реестр текстов воронки (спека admin-panel-v2, тикет 10): дефолты из
 * `templates.ts`, переопределения из БД, чтение одной точкой с памяткой и
 * фолбэком на дефолт при ошибке БД. Плюс канарейка «каждая клиентская строка
 * блока воронки в templates.ts зарегистрирована».
 */

const h = vi.hoisted(() => ({
  overrides: [] as { key: string; value: string; updatedAt: Date; updatedBy: string | null; updatedByName: string | null }[],
  fail: false,
  listOverrides: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock('@oplati/db', () => ({
  getDb: () => ({}),
  listFunnelTextOverrides: h.listOverrides,
}));
vi.mock('@sentry/nextjs', () => ({ captureException: h.captureException, captureMessage: vi.fn() }));

import * as templates from '../telegram/templates.ts';
import {
  FUNNEL_TEXTS,
  FUNNEL_TEXT_KEYS,
  funnelTextSpec,
  getFunnelTexts,
  invalidateFunnelTexts,
  renderFunnelText,
  validateFunnelText,
} from './texts.ts';

beforeEach(() => {
  h.overrides = [];
  h.fail = false;
  h.listOverrides.mockReset();
  h.listOverrides.mockImplementation(async () => {
    if (h.fail) throw new Error('connection refused');
    return h.overrides;
  });
  h.captureException.mockClear();
  invalidateFunnelTexts();
});

describe('реестр', () => {
  it('у каждого ключа непустой дефолт, ключи уникальны, подстановки дефолта совпадают с описанием', () => {
    const keys = FUNNEL_TEXTS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const spec of FUNNEL_TEXTS) {
      expect(spec.defaultValue.trim().length, spec.key).toBeGreaterThan(0);
      // Дефолт сам обязан проходить валидацию — иначе «вернуть по умолчанию»
      // возвращало бы текст, который сохранить нельзя.
      expect(validateFunnelText(spec, spec.defaultValue), spec.key).toEqual({ ok: true, value: spec.defaultValue });
    }
    expect([...FUNNEL_TEXT_KEYS].sort()).toEqual([...keys].sort());
  });

  it('канарейка: каждая клиентская строка блока воронки templates.ts зарегистрирована в реестре', () => {
    // Блок начинается заголовком воронки и идёт до конца файла. Экспорт из него
    // без ключа в реестре — забытая строка, которую владелец не сможет править.
    const here = fileURLToPath(new URL('.', import.meta.url));
    const src = readFileSync(`${here}/../telegram/templates.ts`, 'utf8');
    const block = src.slice(src.indexOf('Воронка обратной связи и удержания'));
    const exported = [...block.matchAll(/^export (?:const|function) ([A-Za-z_]+)/gm)].map((m) => m[1]!);
    expect(exported.length).toBeGreaterThan(10);

    // DM персоналу — не клиентский текст, в реестр не входит намеренно.
    const registered = new Set(FUNNEL_TEXTS.flatMap((s) => s.source));
    const forgotten = exported.filter((name) => name !== 'buildLowRatingStaffAlert' && !registered.has(name));
    expect(forgotten).toEqual([]);

    // И наоборот: реестр ссылается только на существующие экспорты.
    for (const spec of FUNNEL_TEXTS) {
      for (const name of spec.source) {
        expect(name in templates, `${spec.key} → ${name}`).toBe(true);
      }
    }
  });

  it('ответы опроса — по ключу на каждое значение enum, подписи из словаря шаблонов', () => {
    expect(funnelTextSpec('expired_survey.answer.price')?.defaultValue).toBe(
      templates.EXPIRED_SURVEY_ANSWER_LABELS.price,
    );
    expect(funnelTextSpec('start_survey.answer.other')?.defaultValue).toBe(
      templates.START_SURVEY_ANSWER_LABELS.other,
    );
    expect(funnelTextSpec('nope')).toBeUndefined();
  });
});

describe('renderFunnelText', () => {
  it('подставляет параметры', () => {
    expect(renderFunnelText('Оплатить {service} картой? {link}', { service: 'Netflix', link: 'https://t.me/x' })).toBe(
      'Оплатить Netflix картой? https://t.me/x',
    );
  });

  it('неизвестная подстановка в шаблоне — ошибка (защита на чтении, если валидацию обошли)', () => {
    expect(() => renderFunnelText('Привет, {name}', {})).toThrow(/name/);
  });
});

describe('validateFunnelText', () => {
  const rating = funnelTextSpec('order_rating.body')!;
  const nudge = funnelTextSpec('referral_nudge.body')!;
  const button = funnelTextSpec('common.optout_button')!;
  const answer = funnelTextSpec('expired_survey.answer.price')!;

  it('пустой после trim → empty', () => {
    expect(validateFunnelText(rating, '   ')).toEqual({ ok: false, reason: 'empty' });
  });

  it('пропущенная обязательная подстановка → missing_placeholder с именем', () => {
    expect(validateFunnelText(nudge, 'Ссылка потом')).toEqual({
      ok: false,
      reason: 'missing_placeholder',
      placeholder: 'link',
    });
  });

  it('неизвестная подстановка (опечатка) → unknown_placeholder', () => {
    expect(validateFunnelText(nudge, 'Ссылка: {lnk} {link}')).toEqual({
      ok: false,
      reason: 'unknown_placeholder',
      placeholder: 'lnk',
    });
  });

  it('длина: тело — 4096, кнопка — 64', () => {
    expect(validateFunnelText(rating, `{service} ${'а'.repeat(4096)}`)).toEqual({
      ok: false,
      reason: 'too_long',
      max: 4096,
    });
    expect(validateFunnelText(button, 'к'.repeat(65))).toEqual({ ok: false, reason: 'too_long', max: 64 });
    expect(validateFunnelText(button, 'к'.repeat(64)).ok).toBe(true);
  });

  it('подпись ответа опроса не может совпасть с соседней в группе', () => {
    expect(validateFunnelText(answer, templates.EXPIRED_SURVEY_ANSWER_LABELS.howto)).toEqual({
      ok: false,
      reason: 'duplicate_label',
    });
    // С учётом уже сохранённых переопределений соседей.
    expect(
      validateFunnelText(answer, 'Своё', { 'expired_survey.answer.changed': 'Своё' }),
    ).toEqual({ ok: false, reason: 'duplicate_label' });
    expect(validateFunnelText(answer, 'Своё').ok).toBe(true);
  });

  it('валидный текст возвращается обрезанным по краям', () => {
    expect(validateFunnelText(rating, '  Оцени {service}  ')).toEqual({ ok: true, value: 'Оцени {service}' });
  });
});

describe('getFunnelTexts', () => {
  it('без строк в БД — дефолты из кода', async () => {
    const texts = await getFunnelTexts();
    expect(texts['expired_survey.body']).toBe(templates.EXPIRED_SURVEY_TEXT);
    expect(texts['common.optout_button']).toBe(templates.FUNNEL_OPTOUT_BUTTON);
  });

  it('оверлей побеждает дефолт; неизвестный ключ из БД игнорируется', async () => {
    h.overrides = [
      { key: 'expired_survey.body', value: 'Свой текст', updatedAt: new Date(), updatedBy: null, updatedByName: null },
      { key: 'ghost.key', value: 'мусор', updatedAt: new Date(), updatedBy: null, updatedByName: null },
    ];
    const texts = await getFunnelTexts();
    expect(texts['expired_survey.body']).toBe('Свой текст');
    expect(texts['start_survey.body']).toBe(templates.START_SURVEY_TEXT);
    expect(Object.keys(texts)).toEqual([...FUNNEL_TEXT_KEYS]);
  });

  it('ошибка БД — дефолты, лог+Sentry, воронка не падает; неудача не кэшируется', async () => {
    h.fail = true;
    const texts = await getFunnelTexts();
    expect(texts['expired_survey.body']).toBe(templates.EXPIRED_SURVEY_TEXT);
    expect(h.captureException).toHaveBeenCalledTimes(1);

    h.fail = false;
    h.overrides = [
      { key: 'expired_survey.body', value: 'Ожил', updatedAt: new Date(), updatedBy: null, updatedByName: null },
    ];
    expect((await getFunnelTexts())['expired_survey.body']).toBe('Ожил');
  });

  it('памятка: повторное чтение в течение срока не ходит в БД, инвалидация — ходит', async () => {
    await getFunnelTexts();
    await getFunnelTexts();
    expect(h.listOverrides).toHaveBeenCalledTimes(1);
    invalidateFunnelTexts();
    await getFunnelTexts();
    expect(h.listOverrides).toHaveBeenCalledTimes(2);
  });

  it('памятка по времени: через 60 с запрос уходит снова', async () => {
    const t0 = 1_000_000;
    await getFunnelTexts(t0);
    await getFunnelTexts(t0 + 59_000);
    expect(h.listOverrides).toHaveBeenCalledTimes(1);
    await getFunnelTexts(t0 + 61_000);
    expect(h.listOverrides).toHaveBeenCalledTimes(2);
  });
});
