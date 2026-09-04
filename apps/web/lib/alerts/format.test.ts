import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { formatOpsMessage, panelUrl } from './format';

/**
 * Единый шаблон уведомления (трек ops-group, тикет 06): заголовок первой
 * строкой, тело, «Что делать» последней; без действия — без хвоста.
 */
describe('formatOpsMessage', () => {
  it('заголовок, тело, «Что делать» с абсолютной ссылкой на хост панели', () => {
    const text = formatOpsMessage(
      {
        title: 'Оплаченный заказ не доставлен',
        body: 'Заказ ORD-1: выпуск карты упал.',
        action: { text: 'разобрать вручную', path: '/admin/orders/ORD-1' },
      },
      'admin.oplatishka.com',
    );

    expect(text.split('\n\n')).toEqual([
      'Оплаченный заказ не доставлен',
      'Заказ ORD-1: выпуск карты упал.',
      'Что делать: разобрать вручную https://admin.oplatishka.com/admin/orders/ORD-1',
    ]);
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

    expect(text.endsWith('Что делать: открыть /admin/holds')).toBe(true);
  });

  it('действие без пути — только текст', () => {
    const text = formatOpsMessage({ body: 'x', action: { text: 'проверить шлюз' } }, 'admin.example.com');

    expect(text.endsWith('Что делать: проверить шлюз')).toBe(true);
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

  const CALL_SITES = [
    'lib/payments/gateway.ts',
    'lib/contacts/phone-gate.ts',
    'lib/cabinet/referral-actions.ts',
    'lib/freekassa/handlers.ts',
    'lib/freekassa/nonce-alert.ts',
    'lib/tool-handlers/propose-order.ts',
    'lib/loveandpay/handlers.ts',
    'lib/jobs/payment-review-watch.ts',
    'lib/jobs/payment-conversion.ts',
    'lib/jobs/referral-accrual-recovery.ts',
    'lib/jobs/poll-payment-one.ts',
    'lib/jobs/poll-payment.ts',
    'lib/jobs/issue-card.ts',
    'lib/jobs/referral-rollup.ts',
    'lib/jobs/proxy-health.ts',
    'lib/jobs/support-housekeeping.ts',
    'lib/jobs/vcc-balance.ts',
    'lib/pay-space/preflight.ts',
    'lib/telegram/funnel-callbacks.ts',
  ];

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
    for (const rel of CALL_SITES) {
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
