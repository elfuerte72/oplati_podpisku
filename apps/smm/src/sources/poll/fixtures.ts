/** Фикстуры источников: снимки реальной разметки и ответов, урезанные до сути. */

/** Витрина канала `t.me/s/<канал>`: обычный пост, рекламный и пост без ссылки. */
export const TELEGRAM_WIDGET_HTML = `<!doctype html>
<html><body>
<main>
<section class="tgme_channel_history">
  <div class="tgme_widget_message" data-post="ainews/1201">
    <div class="tgme_widget_message_text js-message_text">
      Google открыла память Gemini бесплатным пользователям.
      <a href="https://blog.example.com/gemini-memory" target="_blank">Подробности в блоге</a>
    </div>
    <div class="tgme_widget_message_footer">
      <span class="tgme_widget_message_views">12.3K</span>
      <a class="tgme_widget_message_date" href="https://t.me/ainews/1201">
        <time datetime="2026-09-21T08:30:00+00:00">08:30</time>
      </a>
    </div>
  </div>

  <div class="tgme_widget_message" data-post="ainews/1202">
    <div class="tgme_widget_message_text js-message_text">
      Реклама. Курс по нейросетям со скидкой, успей записаться.
      <a href="https://course.example.com/?utm_source=tg_ainews&amp;erid=2Vtzq" target="_blank">Записаться</a>
    </div>
    <div class="tgme_widget_message_footer">
      <a class="tgme_widget_message_date" href="https://t.me/ainews/1202">
        <time datetime="2026-09-21T09:00:00+00:00">09:00</time>
      </a>
    </div>
  </div>

  <div class="tgme_widget_message" data-post="ainews/1203">
    <div class="tgme_widget_message_text js-message_text">
      Просто мысли вслух про будущее ассистентов, без ссылок.
    </div>
    <div class="tgme_widget_message_footer">
      <a class="tgme_widget_message_date" href="https://t.me/ainews/1203">
        <time datetime="2026-09-21T10:00:00+00:00">10:00</time>
      </a>
    </div>
  </div>
</section>
</main>
</body></html>`;

/** Лента RSS: два элемента, один без даты. */
export const RSS_XML = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel>
  <title>Example Blog</title>
  <item>
    <title>Gemini запомнил прошлые разговоры</title>
    <link>https://blog.example.com/gemini-memory</link>
    <pubDate>Mon, 21 Sep 2026 08:30:00 +0000</pubDate>
  </item>
  <item>
    <title>Заметка без даты &amp; со ссылкой</title>
    <link>https://blog.example.com/no-date</link>
  </item>
</channel></rss>`;

/** Лента Atom: другой корень и другая форма ссылки. */
export const ATOM_XML = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Example Atom</title>
  <entry>
    <title>Новый тариф у ассистента</title>
    <link rel="alternate" href="https://atom.example.com/pricing"/>
    <updated>2026-09-20T12:00:00Z</updated>
  </entry>
</feed>`;

export const HN_TOP_STORIES = [45123456, 45123457, 45123458];

export const HN_ITEM_WITH_URL = {
  id: 45123456,
  type: 'story',
  title: 'Gemini memory for free users',
  url: 'https://blog.example.com/gemini-memory',
  time: 1790000000,
  score: 240,
};

export const HN_ITEM_ASK = {
  id: 45123457,
  type: 'story',
  title: 'Ask HN: как вы платите за подписки?',
  time: 1790000100,
  score: 90,
};

export const REDDIT_RESPONSE = {
  success: true,
  credits_remaining: 6820,
  credits_charged: 1,
  posts: [
    {
      id: 't3_1',
      title: 'Gemini memory is now free',
      url: 'https://blog.example.com/gemini-memory',
      permalink: '/r/singularity/comments/1/gemini_memory/',
      created_at_iso: '2026-09-21T08:30:00.000Z',
      selftext: 'текст чужого поста, который наружу не идёт',
      over_18: false,
    },
    {
      id: 't3_2',
      title: 'Обсуждение без ссылки',
      url: 'https://www.reddit.com/r/singularity/comments/2/discussion/',
      permalink: '/r/singularity/comments/2/discussion/',
      created_at_iso: '2026-09-21T09:00:00.000Z',
      selftext: 'длинный текст',
      over_18: false,
    },
  ],
  after: 't3_2',
};

export const X_RESPONSE = {
  success: true,
  credits_remaining: 6819,
  credits_charged: 1,
  tweets: [
    {
      rest_id: '1800000000000000001',
      legacy: {
        created_at: 'Mon Sep 21 08:30:00 +0000 2026',
        full_text: 'Gemini memory is live for free accounts https://t.co/abc',
        id_str: '1800000000000000001',
      },
      url: 'https://x.com/openai/status/1800000000000000001',
    },
    {
      rest_id: '1700000000000000002',
      legacy: {
        created_at: 'Sat Mar 01 10:00:00 +0000 2025',
        full_text: 'Старый популярный твит',
        id_str: '1700000000000000002',
      },
      url: 'https://x.com/openai/status/1700000000000000002',
    },
  ],
};

export const THREADS_RESPONSE = {
  success: true,
  credits_remaining: 6818,
  credits_charged: 1,
  posts: [
    {
      id: '3100000000000000001_9999',
      pk: '3100000000000000001',
      code: 'DA1bC2d3E4f',
      taken_at: 1790000000,
      user: { username: 'oplatishka', pk: '9999' },
      caption: { text: 'текст чужого поста' },
    },
  ],
};

/**
 * Витрина с постом-ОТВЕТОМ: первым в блоке идёт цитата чужого поста, своим
 * текстом — второй div, а внутри него ещё один вложенный (опрос). На такой
 * разметке парсер по первому совпадению читал цитату вместо поста (ревью
 * 22.09.2026, живые `meduzalive` и `tginfo`).
 */
export const TELEGRAM_REPLY_HTML = `<!doctype html>
<html><body><section class="tgme_channel_history">
  <div class="tgme_widget_message" data-post="chan/500">
    <a class="tgme_widget_message_reply">
      <div class="tgme_widget_message_text js-message_reply_text">
        Цитата чужого поста со ссылкой
        <a href="https://old-news.example.com/court">старая новость</a>
      </div>
    </a>
    <div class="tgme_widget_message_text js-message_text">
      Промокод на курс по нейросетям, налетай.
      <div class="tgme_widget_message_poll">вложенный блок опроса</div>
      <a href="https://course.example.com/?utm_source=tg_chan&amp;erid=2Vtzq">записаться</a>
    </div>
    <div class="tgme_widget_message_footer">
      <span class="tgme_widget_message_views">5.1K</span>
      <a class="tgme_widget_message_date" href="https://t.me/chan/500">
        <time datetime="2026-09-21T11:00:00+00:00">11:00</time>
      </a>
    </div>
  </div>

  <div class="tgme_widget_message" data-post="chan/501">
    <a class="tgme_widget_message_reply">
      <div class="tgme_widget_message_text js-message_reply_text">
        Цитата: <a href="https://quoted.example.com/old">чужая ссылка</a>
      </div>
    </a>
    <div class="tgme_widget_message_text js-message_text">
      Свой текст поста.
      <a href="https://blog.example.com/own-source">первоисточник</a>
    </div>
    <div class="tgme_widget_message_footer">
      <span class="tgme_widget_message_views">834</span>
      <a class="tgme_widget_message_date" href="https://t.me/chan/501">
        <time datetime="2026-09-21T12:00:00+00:00">12:00</time>
      </a>
    </div>
  </div>
</section></body></html>`;
