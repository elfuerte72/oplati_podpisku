import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { formatOpsMessage, panelUrl, splitSentences } from './format';

/**
 * Единый шаблон уведомления (трек ops-group, тикет 06): заголовок первой
 * строкой, тело, «Что делать» последней; без действия — без хвоста.
 */
describe('formatOpsMessage', () => {
  it('маркер потока + заголовок, факты, тело, «Что делать» и ссылка своей строкой', () => {
    const text = formatOpsMessage(
      {
        stream: 'critical',
        title: 'Оплаченный заказ не доставлен',
        facts: [
          { label: 'Заказ', value: 'ORD-1' },
          { label: 'Причина', value: 'paypace_error' },
        ],
        body: 'Выпуск карты упал. Нужен ручной разбор.',
        action: { text: 'разобрать вручную', path: '/admin/orders/ORD-1' },
      },
      'admin.oplatishka.com',
    );

    expect(text).toBe(
      [
        '🔴 Оплаченный заказ не доставлен',
        'Заказ: ORD-1',
        'Причина: paypace_error',
        '',
        'Выпуск карты упал.',
        'Нужен ручной разбор.',
        '',
        'Что делать: разобрать вручную',
        'https://admin.oplatishka.com/admin/orders/ORD-1',
      ].join('\n'),
    );
  });

  it('без потока маркера нет — заголовок как есть', () => {
    const text = formatOpsMessage({ title: 'Заголовок', body: 'тело' }, null);

    expect(text.startsWith('Заголовок\n')).toBe(true);
  });

  it('preformatted: тело не переразбивается (обращение клиента с полями)', () => {
    const body = 'Пользователь: Иван. Петров\nСообщение:\nОплатил. Не работает. Помогите';
    const text = formatOpsMessage({ body, preformatted: true }, null);

    expect(text).toBe(body);
  });

  it('без действия хвоста нет', () => {
    const text = formatOpsMessage({ title: 'К сведению', body: 'тело' }, 'admin.example.com');

    expect(text).toBe('К сведению\n\nтело');
    expect(text).not.toContain('Что делать');
  });

  it('без заголовка — тело первой строкой', () => {
    const text = formatOpsMessage({ body: 'тело', action: { text: 'ответить', path: '/admin/support' } }, null);

    expect(text.startsWith('тело')).toBe(true);
  });

  it('незаданный хост панели → путь без хоста, не пустая ссылка', () => {
    const text = formatOpsMessage({ body: 'x', action: { text: 'открыть', path: '/admin/holds' } }, undefined);

    expect(text.endsWith('Что делать: открыть\n/admin/holds')).toBe(true);
  });

  it('действие без пути — только текст', () => {
    const text = formatOpsMessage({ body: 'x', action: { text: 'проверить шлюз' } }, 'admin.example.com');

    expect(text.endsWith('Что делать: проверить шлюз')).toBe(true);
  });

  it('splitSentences: предложение на строку, числа и сокращения не рвутся', () => {
    expect(
      splitSentences('Выставлено 3 250.00 ₽, оплачено 3 000.00 ₽ (операция 418). Заказ в failed. Пополнение T+1.'),
    ).toBe('Выставлено 3 250.00 ₽, оплачено 3 000.00 ₽ (операция 418).\nЗаказ в failed.\nПополнение T+1.');
    expect(splitSentences('Порядок в docs/incidents.md, инцидент 2026-08-15.')).toBe(
      'Порядок в docs/incidents.md, инцидент 2026-08-15.',
    );
    expect(splitSentences('Клиент сказал «оплатил». Проверить операцию.')).toBe(
      'Клиент сказал «оплатил».\nПроверить операцию.',
    );
  });

  it('ссылка — голый URL, без разметки', () => {
    expect(panelUrl('/admin/pending', 'admin.example.com')).toBe('https://admin.example.com/admin/pending');
    expect(panelUrl('/admin/pending', ' ')).toBe('/admin/pending');
  });
});

/**
 * Канарейка тона — то же правило, что у словаря панели (`lib/panel/labels.test.ts`):
 * адресат уведомлений — персонал, обращение безличное, внутренний инструмент
 * по имени не зовём. Проверяются аргументы вызовов `notifyOps`/`notifyStaff` в
 * исходниках, а не словарь: тексты алёртов живут рядом с событием.
 */
describe('канарейка тона уведомлений персоналу', () => {
  const INFORMAL =
    /(?<![а-яё])(обнови|попробуй|проверь|сверь|подключись|посмотри|подожди|пополни|примени|переключи|убедись|держи|смотри|разбери|ты|тебе|тебя|твой|твоей|твою)(?![а-яё])/i;
  const INTERNAL_TOOLS = /sentry/i;

  /**
   * Точки вызова ищутся по исходникам, а не перечисляются руками: список был бы
   * зеркалом (инвариант 10), и новый алёрт в новом файле проверялся бы, только
   * если кто-то вспомнил про этот тест.
   */
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path) : [path];
    });
  }

  function callSiteFiles(web: string): string[] {
    return [...walk(join(web, 'lib')), ...walk(join(web, 'app'))]
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.includes('/lib/alerts/'))
      .filter((f) => /notify(Ops|Staff)\(/.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(web.length + 1));
  }

  /** Аргументы вызова от строки с `notifyOps(`/`notifyStaff(` до закрывающей `);`. */
  function callSpans(src: string): string[] {
    const lines = src.split('\n');
    const spans: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (!/notify(Ops|Staff)\(/.test(line) || /^\s*(\/\/|\*)/.test(line)) continue;
      if (/\);\s*$/.test(line)) {
        spans.push(line);
        continue;
      }
      // Конец вызова — `);` или `});` на отступе самого вызова: закрывающая
      // скобка объекта опций стоит глубже и концом не считается.
      const indent = /^\s*/.exec(line)?.[0].length ?? 0;
      const chunk = [line];
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j] ?? '';
        chunk.push(next);
        const nextIndent = /^\s*/.exec(next)?.[0].length ?? 0;
        if (/^\s*(\}\s*)?\);\s*$/.test(next) && nextIndent <= indent) break;
      }
      spans.push(chunk.join('\n'));
    }
    return spans;
  }

  it('регэксп ловит «ты»-формы — иначе канарейка не умеет падать', () => {
    expect(INFORMAL.test('Проверь шлюз и переключи провайдера.')).toBe(true);
    expect(INFORMAL.test('Проверить шлюз и переключить провайдера.')).toBe(false);
  });

  it('ни один текст уведомления не обращается на «ты» и не отсылает к внутреннему трекеру', () => {
    const here = fileURLToPath(new URL('.', import.meta.url));
    const web = join(here, '..', '..');
    const offenders: string[] = [];
    let spans = 0;
    const files = callSiteFiles(web);
    expect(files.length).toBeGreaterThan(15);
    for (const rel of files) {
      const src = readFileSync(join(web, rel), 'utf8');
      for (const span of callSpans(src)) {
        spans += 1;
        const code = span.replace(/(^|\s)\/\/.*$/gm, '');
        for (const line of code.split('\n')) {
          if (INFORMAL.test(line) || INTERNAL_TOOLS.test(line)) offenders.push(`${rel}: ${line.trim()}`);
        }
      }
    }
    expect(spans).toBeGreaterThan(30);
    expect(offenders).toEqual([]);
  });
});
