import { describe, expect, it } from 'vitest';

import { smmConfig } from '../config/smm.config.ts';
import { buildKeyboard, renderPost, toTelegramHtml, type RenderablePost } from './render.ts';
import { sendPost, type SendApi, type SendOptions } from './send.ts';

function post(overrides: Partial<RenderablePost> = {}): RenderablePost {
  return {
    layout: 'a',
    body: `# Google раздала память Gemini бесплатным пользователям

Раньше приходилось пересказывать вчерашний разговор. Теперь помощник помнит его сам.

Проверить можно за минуту в приложении на телефоне.`,
    sourceUrl: 'https://blog.example.com/gemini-memory',
    ...overrides,
  };
}

const RICH_BODY = `# Разбор нового тарифа показывает простую вещь

Лид про задачу читателя и что изменилось за неделю.

## Сколько стоит

- **Базовый.** Хватает для писем.
- **Платный.** Нужен для таблиц.
- **Командный.** Нужен, если вас больше трёх.

Нюанс: считают за месяц.`;

describe('раскладка А: обычное сообщение', () => {
  it('заголовок становится жирной первой строкой, подпись «Источник» в конце', () => {
    const result = renderPost(post());
    expect(result.ok).toBe(true);
    if (!result.ok || result.outgoing.kind !== 'classic') throw new Error('ожидался classic');
    expect(result.outgoing.text).toMatch(/^<b>Google раздала память Gemini бесплатным пользователям<\/b>/);
    expect(result.outgoing.text).toContain('<a href="https://blog.example.com/gemini-memory">Источник</a>');
    expect(result.outgoing.parseMode).toBe('HTML');
  });

  it('без источника подписи нет', () => {
    const result = renderPost(post({ sourceUrl: undefined }));
    expect(result.ok).toBe(true);
    if (!result.ok || result.outgoing.kind !== 'classic') throw new Error('ожидался classic');
    expect(result.outgoing.text).not.toContain('Источник');
  });

  it('с картинкой уходит подписью к фото', () => {
    const result = renderPost(post({ imagePath: '/tmp/cover.jpg' }));
    expect(result.ok).toBe(true);
    if (!result.ok || result.outgoing.kind !== 'classic') throw new Error('ожидался classic');
    expect(result.outgoing.photoPath).toBe('/tmp/cover.jpg');
  });

  it('HTML-сущности в тексте экранируются', () => {
    const result = renderPost(post({ body: '# Заголовок про 5 < 6 & прочее\n\nТело с <b>тегом</b> внутри.' }));
    expect(result.ok).toBe(true);
    if (!result.ok || result.outgoing.kind !== 'classic') throw new Error('ожидался classic');
    expect(result.outgoing.text).toContain('5 &lt; 6 &amp; прочее');
    expect(result.outgoing.text).toContain('&lt;b&gt;тегом&lt;/b&gt;');
  });

  it('цитата превращается в свёрнутую цитату', () => {
    const html = toTelegramHtml('# Заголовок\n\n> Цитата из блога компании\n> вторая строка');
    expect(html).toContain('<blockquote expandable>');
    expect(html).toContain('</blockquote>');
  });

  it('инлайн-разметка переводится в теги', () => {
    const html = toTelegramHtml('Это **важно**, это *ремарка*, это `команда`, а это [ссылка](https://example.com).');
    expect(html).toContain('<b>важно</b>');
    expect(html).toContain('<i>ремарка</i>');
    expect(html).toContain('<code>команда</code>');
    expect(html).toContain('<a href="https://example.com">ссылка</a>');
  });
});

describe('раскладки Б, В, Г: rich-сообщение', () => {
  it('тело уходит markdown-ом, обложка первым блоком, медиа отдельным элементом', () => {
    const result = renderPost(post({ layout: 'b', body: RICH_BODY, imagePath: '/tmp/cover.jpg' }));
    expect(result.ok).toBe(true);
    if (!result.ok || result.outgoing.kind !== 'rich') throw new Error('ожидался rich');
    expect(result.outgoing.markdown.startsWith('![](tg://photo?id=cover)')).toBe(true);
    expect(result.outgoing.media).toEqual([{ id: 'cover', path: '/tmp/cover.jpg' }]);
    expect(result.outgoing.markdown).toContain('## Сколько стоит');
    expect(result.outgoing.markdown).toContain('<footer><a href="https://blog.example.com/gemini-memory">Источник</a></footer>');
  });

  it('маркер картинки ставит обложку в середину, а не сверху', () => {
    const body = RICH_BODY.replace('Нюанс: считают за месяц.', '[[IMAGE]]\n\nНюанс: считают за месяц.');
    const result = renderPost(post({ layout: 'b', body, imagePath: '/tmp/cover.jpg' }));
    expect(result.ok).toBe(true);
    if (!result.ok || result.outgoing.kind !== 'rich') throw new Error('ожидался rich');
    expect(result.outgoing.markdown.startsWith('![](tg://photo?id=cover)')).toBe(false);
    expect(result.outgoing.markdown).toContain('![](tg://photo?id=cover)');
  });

  it('без картинки маркер удаляется, а не остаётся в тексте', () => {
    const body = RICH_BODY.replace('Нюанс: считают за месяц.', 'Нюанс: считают за месяц.');
    const result = renderPost(post({ layout: 'b', body }));
    expect(result.ok).toBe(true);
    if (!result.ok || result.outgoing.kind !== 'rich') throw new Error('ожидался rich');
    expect(result.outgoing.markdown).not.toContain('[[IMAGE]]');
    expect(result.outgoing.media).toEqual([]);
  });

  it('таблица раскладки Г доезжает до разметки как есть', () => {
    const body = `# Заголовок с ответом

Лид про задачу читателя.

| Сервис | Цена |
|---|---|
| Первый | 20 |

Кому что: бери первый.`;
    const result = renderPost(post({ layout: 'g', body }));
    expect(result.ok).toBe(true);
    if (!result.ok || result.outgoing.kind !== 'rich') throw new Error('ожидался rich');
    expect(result.outgoing.markdown).toContain('| Сервис | Цена |');
  });
});

describe('кнопки', () => {
  it('кнопка бота стоит всегда и последней', () => {
    const keyboard = buildKeyboard(post());
    expect(keyboard.rows).toHaveLength(1);
    expect(keyboard.rows[0]?.[0]?.url).toBe(smmConfig.buttons.bot.url);
  });

  it('своя кнопка поста встаёт НАД кнопкой бота', () => {
    const keyboard = buildKeyboard(
      post({ buttonText: 'Открыть Gemini', buttonUrl: 'https://gemini.google.com' }),
    );
    expect(keyboard.rows).toHaveLength(2);
    expect(keyboard.rows[0]?.[0]?.text).toBe('Открыть Gemini');
    expect(keyboard.rows[1]?.[0]?.url).toBe(smmConfig.buttons.bot.url);
  });

  it('кнопка с негодным адресом не ставится', () => {
    const keyboard = buildKeyboard(post({ buttonText: 'Открыть', buttonUrl: 'javascript:alert(1)' }));
    expect(keyboard.rows).toHaveLength(1);
  });
});

describe('отказы рендера', () => {
  it('маркер картинки без файла — отказ с причиной', () => {
    const result = renderPost(post({ body: '# Заголовок\n\nТело [[IMAGE]] дальше.' }));
    expect(result).toMatchObject({ ok: false, reason: 'image_marker_without_file' });
  });

  it('обложка без ссылки на источник — отказ', () => {
    // Обложка приходит из статьи: без ссылки это чужая картинка без указания.
    const result = renderPost(post({ imagePath: '/tmp/cover.jpg', sourceUrl: undefined }));
    expect(result).toMatchObject({ ok: false, reason: 'cover_without_source' });
  });

  it('пустое тело — отказ', () => {
    expect(renderPost(post({ body: '   ' }))).toMatchObject({ ok: false, reason: 'empty_body' });
  });

  it('текст длиннее лимита сообщения ловится ДО вызова API', () => {
    const long = `# Заголовок\n\n${'а'.repeat(5000)}`;
    expect(renderPost(post({ body: long }))).toMatchObject({ ok: false, reason: 'too_long' });
  });

  it('подпись к фото длиннее лимита ловится ДО вызова API', () => {
    const long = `# Заголовок\n\n${'а'.repeat(1200)}`;
    const result = renderPost(post({ body: long, imagePath: '/tmp/cover.jpg' }));
    expect(result).toMatchObject({ ok: false, reason: 'too_long' });
    if (result.ok) return;
    expect(result.message).toContain('подпись к фото');
  });

  it('rich длиннее потолка знаков ловится ДО вызова API', () => {
    const long = `# Заголовок\n\n${'а'.repeat(40_000)}`;
    expect(renderPost(post({ layout: 'b', body: long }))).toMatchObject({
      ok: false,
      reason: 'too_long',
    });
  });

  it('слишком много блоков ловится ДО вызова API', () => {
    const many = `# Заголовок\n\n${Array.from({ length: 600 }, (_, i) => `- пункт ${i}`).join('\n')}`;
    expect(renderPost(post({ layout: 'b', body: many }))).toMatchObject({
      ok: false,
      reason: 'too_many_blocks',
    });
  });
});

interface Recorded {
  readonly method: string;
  readonly chatId: string | number;
  readonly payload: unknown;
  readonly options: SendOptions & { caption?: string };
}

function fakeApi(): { api: SendApi; calls: Recorded[]; fail?: () => void } {
  const calls: Recorded[] = [];
  const api: SendApi = {
    sendRichMessage(chatId, rich, options) {
      calls.push({ method: 'sendRichMessage', chatId, payload: rich, options });
      return Promise.resolve({ message_id: 101 });
    },
    sendPhoto(chatId, photo, options) {
      calls.push({ method: 'sendPhoto', chatId, payload: photo, options });
      return Promise.resolve({ message_id: 102 });
    },
    sendMessage(chatId, text, options) {
      calls.push({ method: 'sendMessage', chatId, payload: text, options });
      return Promise.resolve({ message_id: 103 });
    },
  };
  return { api, calls };
}

describe('sendPost', () => {
  it('rich уходит одним вызовом с медиа и клавиатурой', async () => {
    const rendered = renderPost(post({ layout: 'b', body: RICH_BODY, imagePath: '/tmp/cover.jpg' }));
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    const { api, calls } = fakeApi();
    const result = await sendPost(api, { chatId: '-100123' }, rendered.outgoing);
    expect(result).toEqual({ ok: true, messageId: 101 });
    expect(calls[0]?.method).toBe('sendRichMessage');
    expect(calls[0]?.payload).toMatchObject({ media: [{ id: 'cover', file: { path: '/tmp/cover.jpg' } }] });
    expect(calls[0]?.options.keyboard?.rows).toHaveLength(1);
  });

  it('превью и канал — ОДИН и тот же вызов, различается только адресат', async () => {
    // Разойдись они, владелец утверждал бы одно, а в канал уходило другое.
    const rendered = renderPost(post({ layout: 'b', body: RICH_BODY }));
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    const { api, calls } = fakeApi();
    await sendPost(api, { chatId: 379336096 }, rendered.outgoing);
    await sendPost(api, { chatId: '-1004257122135', threadId: 3 }, rendered.outgoing);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.method).toBe(calls[1]?.method);
    expect(calls[0]?.payload).toEqual(calls[1]?.payload);
    expect(calls[0]?.options.keyboard).toEqual(calls[1]?.options.keyboard);
    expect(calls[0]?.options.threadId).toBeUndefined();
    expect(calls[1]?.options.threadId).toBe(3);
  });

  it('classic с фото уходит sendPhoto, без фото — sendMessage', async () => {
    const withPhoto = renderPost(post({ imagePath: '/tmp/cover.jpg' }));
    const withoutPhoto = renderPost(post());
    expect(withPhoto.ok && withoutPhoto.ok).toBe(true);
    if (!withPhoto.ok || !withoutPhoto.ok) return;
    const { api, calls } = fakeApi();
    await sendPost(api, { chatId: 1 }, withPhoto.outgoing);
    await sendPost(api, { chatId: 1 }, withoutPhoto.outgoing);
    expect(calls.map((c) => c.method)).toEqual(['sendPhoto', 'sendMessage']);
    expect(calls[0]?.options.caption).toContain('Google раздала память');
  });

  it('отказ Bot API приходит Result-ом с кодом', async () => {
    const rendered = renderPost(post());
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    const api: SendApi = {
      sendRichMessage() {
        return Promise.reject(new Error('не должно вызваться'));
      },
      sendPhoto() {
        return Promise.reject(new Error('не должно вызваться'));
      },
      sendMessage() {
        return Promise.reject(Object.assign(new Error('Forbidden'), { error_code: 403, description: 'bot was blocked by the user' }));
      },
    };
    const result = await sendPost(api, { chatId: 1 }, rendered.outgoing);
    expect(result).toMatchObject({ ok: false, code: 403 });
    if (result.ok) return;
    expect(result.message).toContain('blocked');
  });
});
