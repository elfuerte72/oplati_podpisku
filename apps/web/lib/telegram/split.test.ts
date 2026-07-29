import { describe, expect, it } from 'vitest';

process.env.APP_URL = 'https://example.com';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service';

import { splitForTelegram, TELEGRAM_MESSAGE_LIMIT } from './send.ts';

/** Собрать текст заданной длины из строк по `lineLen` символов. */
function lines(count: number, lineLen = 20): string {
  return Array.from({ length: count }, (_, i) => `${i}`.padEnd(lineLen, 'x')).join('\n');
}

describe('splitForTelegram', () => {
  it('короткий текст не трогает — ровно один кусок, байт в байт', () => {
    const text = 'привет\nкак дела';
    expect(splitForTelegram(text, TELEGRAM_MESSAGE_LIMIT)).toEqual([text]);
  });

  it('каждый кусок укладывается в лимит', () => {
    const text = lines(200);
    for (const chunk of splitForTelegram(text, 100)) {
      expect(chunk.length).toBeLessThanOrEqual(100);
    }
  });

  it('ничего не теряется и не дублируется — склейка даёт исходный текст', () => {
    // Разрез идёт по границам строк, поэтому обратная склейка — через \n.
    const text = lines(50, 15);
    expect(splitForTelegram(text, 120).join('\n')).toBe(text);
  });

  it('не разрывает code-блок посередине', () => {
    const code = ['```js', ...Array.from({ length: 10 }, (_, i) => `const a${i} = ${i};`), '```'].join(
      '\n',
    );
    const text = `Вот код:\n${code}\nи хвост`;

    const chunks = splitForTelegram(text, 200);
    const withFence = chunks.filter((c) => c.includes('```'));
    // Блок целиком в одном куске: значит там ОБЕ ограждающие строки.
    for (const chunk of withFence) {
      expect((chunk.match(/```/g) ?? []).length % 2).toBe(0);
    }
  });

  it('атом длиннее лимита режется по символам, а не теряется', () => {
    // Одна строка без переводов — по границам делить негде.
    const text = 'y'.repeat(250);
    const chunks = splitForTelegram(text, 100);
    expect(chunks).toHaveLength(3);
    expect(chunks.join('')).toBe(text);
  });

  it('незакрытый ```-блок не роняет разбивку', () => {
    // Модель забыла закрыть fence: остаток идёт одним атомом, но лимит держим.
    const text = `начало\n\`\`\`js\n${'z'.repeat(300)}`;
    const chunks = splitForTelegram(text, 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(100);
  });

  it('текст ровно по лимиту остаётся одним куском (граница)', () => {
    const text = 'q'.repeat(TELEGRAM_MESSAGE_LIMIT);
    expect(splitForTelegram(text, TELEGRAM_MESSAGE_LIMIT)).toHaveLength(1);
    expect(splitForTelegram(`${text}q`, TELEGRAM_MESSAGE_LIMIT)).toHaveLength(2);
  });

  it('пустой текст не превращается в пустой список', () => {
    expect(splitForTelegram('', TELEGRAM_MESSAGE_LIMIT)).toEqual(['']);
  });
});
