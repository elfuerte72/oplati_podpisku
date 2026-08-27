import { describe, expect, it } from 'vitest';

import {
  buildSupportKnowledgeBase,
  buildSupportSystemPrompt,
  type SupportFacts,
} from './support-prompt.ts';

/**
 * База знаний и системный текст помощника (спека §5).
 *
 * Проверяем содержание, а не форму: попали ли динамические факты внутрь и не
 * протекло ли туда запрещённое. Промпт — это просьба к модели; чем чище
 * исходный текст, тем меньше работы у выходного фильтра.
 */

const facts: SupportFacts = {
  cardIssueFeeUsdCents: 400,
  cardLifetimeDays: 30,
  priceLockHours: 2,
  invoiceTtlHours: 1,
  operatorHours: { fromHour: 10, toHour: 22, tzLabel: 'МСК' },
  phoneRequiredFromRub: 10000,
};

describe('buildSupportSystemPrompt — динамические факты', () => {
  it('надбавка за выпуск карты названа в долларах из центов', () => {
    expect(buildSupportSystemPrompt(facts)).toContain('$4');
  });

  it('нулевая надбавка описывается как её отсутствие, а не как «$0»', () => {
    const text = buildSupportSystemPrompt({ ...facts, cardIssueFeeUsdCents: 0 });
    expect(text).toContain('надбавки за выпуск карты сейчас нет');
    expect(text).not.toContain('$0');
  });

  it('срок карты, фиксация цены и срок счёта берутся из фактов, а не из текста', () => {
    const text = buildSupportSystemPrompt({
      ...facts,
      cardLifetimeDays: 45,
      priceLockHours: 3,
      invoiceTtlHours: 6,
    });
    expect(text).toContain('45 дней');
    expect(text).toContain('3 ч');
    expect(text).toContain('6 ч');
  });

  it('часы операторов подставляются', () => {
    expect(buildSupportSystemPrompt(facts)).toContain('с 10:00 до 22:00 МСК');
  });

  it('порог телефона называется суммой', () => {
    expect(buildSupportSystemPrompt(facts)).toContain('10000 ₽');
  });

  it('порога нет — про телефон помощник не заговаривает', () => {
    const text = buildSupportSystemPrompt({ ...facts, phoneRequiredFromRub: null });
    expect(text).toContain('Телефон при оплате не запрашивается');
    expect(text).not.toContain('₽ платёжная система');
  });
});

describe('чего в базе быть не должно', () => {
  // ⚠️ Денилист проверяется по БАЗЕ ЗНАНИЙ, а не по всему промпту: промпт
  // обязан называть запретные темы, иначе он не смог бы их запретить —
  // «не называйте процент комиссии» неизбежно содержит слово «процент».
  // Конкретные ИМЕНА (партнёры, страна, модель) не должны встречаться нигде,
  // в том числе в запретах: их и запрещают описанием категории.
  const text = buildSupportKnowledgeBase(facts);
  const wholePrompt = buildSupportSystemPrompt(facts);

  it('имена платёжных партнёров и выпускающего карты не упоминаются НИГДЕ', () => {
    for (const partner of ['PaySpace', 'Freekassa', 'Love&Pay', 'Loveandpay', 'Rapira']) {
      expect(wholePrompt.toLowerCase()).not.toContain(partner.toLowerCase());
    }
  });

  it('страна выпуска карты не называется НИГДЕ', () => {
    for (const word of ['американск', 'США', 'USA', 'европейск']) {
      expect(wholePrompt).not.toContain(word);
    }
    // Карта описывается как виртуальная — это и есть замена стране выпуска.
    expect(text).toContain('виртуальн');
  });

  it('процент комиссии, курс и формула цены не раскрываются', () => {
    for (const word of ['комиссия', 'процент', 'курс', '%']) {
      expect(text.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });

  it('внутренние идентификаторы статусов не попали НИКУДА', () => {
    for (const status of ['payment_review', 'ready_for_payment', 'in_fulfillment', 'pending_payment']) {
      expect(wholePrompt).not.toContain(status);
    }
  });

  it('какая модель отвечает — не называется НИГДЕ', () => {
    for (const word of ['DeepSeek', 'Claude', 'Anthropic', 'GPT']) {
      expect(wholePrompt).not.toContain(word);
    }
  });
});

describe('buildSupportSystemPrompt — правила разговора', () => {
  const text = buildSupportSystemPrompt(facts);

  it('закрытый мир объявлен явно: нет в базе — зовём оператора', () => {
    expect(text).toContain('ТОЛЬКО из раздела «База знаний»');
    expect(text).toContain('оператор');
  });

  it('обращение на «вы» и запрет эмодзи заданы', () => {
    expect(text).toContain('на «вы»');
    expect(text).toContain('без эмодзи');
  });

  it('повторная выдача реквизитов карты запрещена', () => {
    expect(text).toContain('Реквизиты карты повторно');
  });

  it('статус заказа — только по инструменту', () => {
    expect(text).toContain('ТОЛЬКО по результату\nинструмента');
  });
});
