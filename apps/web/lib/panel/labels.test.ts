import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { cardStatus, orderStatus, paymentStatus } from '@oplati/types';

import * as labels from './labels';
import * as roles from './roles';
import {
  ACTION_TITLES,
  attentionLabel,
  CARD_STATUS_LABELS,
  COLUMN_TITLES,
  ORDER_STATUS_LABELS,
  PAYMENT_STATUS_LABELS,
  PRESET_TITLES,
  SECTION_TITLES,
  SORT_TITLES,
} from './labels';

/**
 * Словарь панели (редизайн, тикет 01). Термин живёт в ОДНОМ месте: «Недожатые»
 * было записано вручную в пяти файлах, и переименование разъезжалось молча.
 *
 * Тесты проверяют поведение словаря, а не переписывают его: точные значения
 * закреплены только за терминами, ради которых редизайн затевался.
 */
describe('названия разделов', () => {
  it('разделы называются тем, что в них лежит, а не жаргоном', () => {
    // «Недожатые» звучало как оценка клиента, «холд» — сленг эквайринга.
    expect(SECTION_TITLES.pending).toBe('Ждут оплаты');
    expect(SECTION_TITLES.holds).toBe('Проверка платежей');
  });
});

describe('статусы заказа, платежа и карты', () => {
  it('у КАЖДОГО статуса заказа есть подпись, и подписи не повторяются', () => {
    // Полнота держится типом `Record<OrderStatus, string>` (сборка), здесь —
    // рантайм-проверка по живому enum'у и уникальность: два разных состояния с
    // одной подписью менеджер в таблице не различит.
    const labels = orderStatus.options.map((status) => ORDER_STATUS_LABELS[status]);
    for (const label of labels) expect(label).toMatch(/^[А-ЯЁ]/);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('термины, ради которых затевался редизайн', () => {
    expect(ORDER_STATUS_LABELS.expired).toBe('Истёк срок');
    expect(ORDER_STATUS_LABELS.failed).toBe('Ошибка');
    expect(ORDER_STATUS_LABELS.ready_for_payment).toBe('Счёт не выставлен');
    expect(ORDER_STATUS_LABELS.pending_payment).toBe('Ожидает оплаты');
    expect(ORDER_STATUS_LABELS.payment_review).toBe('Платёж на проверке');
  });

  it('каждый статус платежа и карты подписан с прописной, без повторов', () => {
    const payment = paymentStatus.options.map((s) => PAYMENT_STATUS_LABELS[s]);
    const card = cardStatus.options.map((s) => CARD_STATUS_LABELS[s]);
    for (const label of [...payment, ...card]) expect(label).toMatch(/^[А-ЯЁ]/);
    expect(new Set(payment).size).toBe(payment.length);
    expect(new Set(card).size).toBe(card.length);
  });

  it('«pending» платежа — ожидание подтверждения, а не оплаты', () => {
    // При антифрод-холде деньги у клиента УЖЕ списаны, а строка платежа
    // остаётся pending. «Ожидает оплаты» было бы ложью ровно там, где экран
    // проверки платежей и нужен.
    expect(PAYMENT_STATUS_LABELS.pending).toBe('Ожидает подтверждения');
  });
});

describe('фильтры, сортировка, колонки, действия', () => {
  it('пресеты фильтра заказов говорят на языке работы', () => {
    // Ключи адреса (`unpaid`, `review`, `failed`) НЕ меняются — ссылки уже
    // разосланы и живут в закладках. Меняется только текст.
    expect(PRESET_TITLES.unpaid).toBe('Ждут оплаты');
    expect(PRESET_TITLES.review).toBe('На проверке');
    expect(PRESET_TITLES.failed).toBe('С ошибкой');
  });

  it('сортировка называет и признак, и направление', () => {
    // «Дорогие» без существительного двусмысленно: дорогие заказы или дорогие
    // сервисы?
    expect(SORT_TITLES.newest).toBe('Сначала новые');
    expect(SORT_TITLES.amount_desc).toBe('Сумма: больше');
  });

  it('колонки называют сущность, а не глагол', () => {
    expect(COLUMN_TITLES.responsible).toBe('Ответственный');
    expect(COLUMN_TITLES.providerStatus).toBe('Статус в Freekassa');
    expect(COLUMN_TITLES.clientNotified).toBe('Клиент уведомлён');
  });

  it('кнопка называет действие, а не рапорт', () => {
    expect(ACTION_TITLES.fulfillmentStart).toBe('Взять в работу');
    expect(ACTION_TITLES.fulfillmentComplete).toBe('Отметить выданным');
    expect(ACTION_TITLES.payoutPaidConfirm).toBe('Подтвердить выплату');
  });
});

describe('attentionLabel', () => {
  it('число согласуется с глаголом', () => {
    expect(attentionLabel(1)).toBe('1 требует внимания');
    expect(attentionLabel(2)).toBe('2 требуют внимания');
    expect(attentionLabel(5)).toBe('5 требуют внимания');
    expect(attentionLabel(11)).toBe('11 требуют внимания');
    expect(attentionLabel(21)).toBe('21 требует внимания');
  });
});

/**
 * Канарейка тона. Правило «безлично, без Sentry» нельзя удержать памятью на
 * ревью — оно держится тестом, как денилист контактов в
 * `lib/contacts/redact-canary.test.ts`.
 */
describe('канарейка тона', () => {
  // `\b` в JS не знает кириллицы, поэтому границы слова — через lookaround.
  const INFORMAL =
    /(?<![а-яё])(обнови|попробуй|войди|загляни|нажми|проверь|сверь|подключись|опиши|отметь|посмотри|подожди|начни|скопируй|попроси|вернись|подставь|ты|тебе|тебя|твой|твоей|твою)(?![а-яё])/i;
  const INTERNAL_TOOLS = /sentry/i;

  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path) : [path];
    });
  }

  function stringLeaves(value: unknown, out: string[] = []): string[] {
    if (typeof value === 'string') out.push(value);
    else if (value && typeof value === 'object') {
      for (const v of Object.values(value)) stringLeaves(v, out);
    }
    return out;
  }

  it('регэксп ловит обращение на «ты» — иначе канарейка не умеет падать', () => {
    expect(INFORMAL.test('Обнови страницу и попробуй ещё раз.')).toBe(true);
    expect(INFORMAL.test('Твоей роли этот раздел закрыт.')).toBe(true);
    // А «Обновите» и «попробуйте» — это НЕ «обнови»: lookaround не даёт
    // канарейке кричать на формальные формы.
    expect(INFORMAL.test('Обновите страницу и попробуйте снова.')).toBe(false);
  });

  it('ни одна строка словаря не обращается на «ты» и не отсылает к Sentry', () => {
    const offenders = [...stringLeaves(labels), ...stringLeaves(roles)].filter(
      (s) => INFORMAL.test(s) || INTERNAL_TOOLS.test(s),
    );
    expect(offenders).toEqual([]);
  });

  it('тексты, написанные прямо на страницах панели, тоже безличны', () => {
    // Словарь покрывает подписи, но пояснения под заголовками живут в JSX.
    // Сканируем исходники без комментариев: строка на «ты» в разметке иначе
    // проходила бы ревью так же незаметно, как раньше.
    const here = fileURLToPath(new URL('.', import.meta.url));
    const web = join(here, '..', '..');
    const files = [...walk(join(web, 'app', 'admin')), ...walk(join(web, 'components', 'panel'))]
      .filter((f) => f.endsWith('.tsx'));
    expect(files.length).toBeGreaterThan(10);

    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|\s)\/\/.*$/gm, '');
      for (const line of src.split('\n')) {
        if (INFORMAL.test(line) || INTERNAL_TOOLS.test(line)) {
          offenders.push(`${file.slice(web.length + 1)}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
