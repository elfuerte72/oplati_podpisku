import { describe, expect, it } from 'vitest';

import { smmConfig } from '../config/smm.config.ts';
import { threadsHandoff } from './handoff.ts';
import { threadsIntentUrl } from './intent.ts';

const SEP = `\n${smmConfig.threads.separator}\n`;

describe('адрес Web Intent', () => {
  it('кодирует текст и тег, пробел даёт %20', () => {
    const url = threadsIntentUrl('Две строки', 'оплатишка');
    expect(url.startsWith(`${smmConfig.threads.intentBase}?`)).toBe(true);
    expect(url).toContain('%20');
    expect(url).not.toContain('+');
    expect(url).toContain('tag=');
  });

  it('не несёт параметр url: на Android он теряется при переходе в приложение', () => {
    const url = threadsIntentUrl('Текст со ссылкой https://example.com/a');
    expect(new URL(url).searchParams.get('url')).toBeNull();
  });

  it('без тега параметра tag нет', () => {
    expect(new URL(threadsIntentUrl('Текст')).searchParams.get('tag')).toBeNull();
  });
});

describe('передача поста владельцу', () => {
  it('первым сообщением идёт сам пост с кнопкой «Открыть в Threads»', () => {
    const messages = threadsHandoff({ body: 'Первая часть поста.', tag: 'ии' });
    expect(messages).toHaveLength(1);
    const first = messages[0];
    expect(first?.kind).toBe('text');
    expect(first?.text).toContain('Первая часть поста.');
    expect(first?.button?.url).toBe(threadsIntentUrl('Первая часть поста.', 'ии'));
  });

  it('кнопка несёт ТОЛЬКО первую часть: остальные уходят ответами', () => {
    const body = ['Первая.', 'Вторая.', 'Третья.'].join(SEP);
    const messages = threadsHandoff({ body });
    expect(messages[0]?.button?.url).toBe(threadsIntentUrl('Первая.'));
    expect(messages[0]?.text).toContain('цепочка из 3 частей');
  });

  it('части цепочки уходят блоками <pre> с пометкой html', () => {
    const body = ['Первая.', 'Вторая <b> часть.'].join(SEP);
    const messages = threadsHandoff({ body });
    const parts = messages.filter((message) => message.html === true);
    expect(parts).toHaveLength(1);
    expect(parts[0]?.text).toContain('<pre>Вторая &lt;b&gt; часть.</pre>');
    // Пояснение про ответы идёт ОДНО на всю цепочку, а не к каждой части.
    expect(messages.filter((message) => message.text.includes('нажми «Ответить»'))).toHaveLength(1);
  });

  it('картинка уходит отдельным сообщением: кнопка её не передаёт', () => {
    const messages = threadsHandoff({ body: 'Пост.', imagePath: '/tmp/a.jpg' });
    const photo = messages.find((message) => message.kind === 'photo');
    expect(photo?.photoPath).toBe('/tmp/a.jpg');
    expect(photo?.text).toContain('приложи');
  });

  it('слишком длинный адрес заменяется кнопкой копирования, а не битой ссылкой', () => {
    // Кириллица в percent-encoding — шесть знаков на букву: адрес перерастает
    // потолок раньше, чем текст перерастает лимит площадки вдвое.
    const long = 'я'.repeat(smmConfig.threads.pieceLimit * 2);
    const messages = threadsHandoff({ body: long });
    expect(messages[0]?.button?.url).toBeUndefined();
    expect(messages[0]?.button?.copyText).toBe(long);
  });

  it('несогласие редактора проговаривается словами кода, а не прячется', () => {
    const messages = threadsHandoff({ body: 'Пост.', judgeNote: 'Редактор против: слабый крючок' });
    expect(messages[0]?.text).toContain('Редактор против');
  });
});
