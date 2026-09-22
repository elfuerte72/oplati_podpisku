/**
 * HTML-фикстуры для тестов разбора статьи. Отдельным файлом, чтобы тесты
 * читались как проверки правил, а не как стена разметки.
 */

const LEAD =
  'Google открыла память Gemini всем пользователям, включая бесплатные аккаунты. ' +
  'Раньше функция работала только у подписки, и разговор приходилось пересказывать заново.';

const BODY =
  'Память включается в настройках профиля и работает во всех регионах, где доступен ' +
  'сам помощник. В блоге компании сказано, что раскатывание заняло две недели.';

export const ARTICLE_HTML = `<!doctype html>
<html lang="en">
<head>
  <title>Google rolls out Gemini memory to everyone | Example Blog</title>
  <meta property="og:title" content="Google открыла память Gemini всем">
  <meta property="og:site_name" content="Example Blog">
  <meta property="og:image" content="/images/cover-gemini.jpg">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="article:published_time" content="2026-09-18T10:00:00Z">
</head>
<body>
  <nav><a href="/">Главная</a> <a href="/about">О нас</a></nav>
  <header><h1>Example Blog</h1></header>
  <article>
    <p>${LEAD}</p>
    <p>${BODY}</p>
    <p>Короткая подпись.</p>
  </article>
  <aside><p>Читайте также совсем другую статью про погоду и её влияние на всё сразу.</p></aside>
  <footer><p>Все права защищены, и это тоже длинный текст, который в статью не входит.</p></footer>
  <script>var tracker = {a: 1};</script>
</body>
</html>`;

/** Страница, у которой в og:image стоит логотип: обложкой он быть не может. */
export const LOGO_COVER_HTML = ARTICLE_HTML.replace(
  '<meta property="og:image" content="/images/cover-gemini.jpg">',
  '<meta property="og:image" content="https://cdn.example.com/static/logo-512.png">',
);

/** Страница, у которой обложка маленькая: в ленте она выглядит мусором. */
export const SMALL_COVER_HTML = ARTICLE_HTML.replace(
  '<meta property="og:image:width" content="1200">',
  '<meta property="og:image:width" content="120">',
).replace('<meta property="og:image:height" content="630">', '<meta property="og:image:height" content="60">');

/** Страница без og:image, но с twitter:image. */
export const TWITTER_COVER_HTML = ARTICLE_HTML.replace(
  '<meta property="og:image" content="/images/cover-gemini.jpg">',
  '<meta name="twitter:image" content="https://cdn.example.com/media/shot.png">',
);

/** Пейволл: заголовок есть, текста нет. */
export const PAYWALL_HTML = `<!doctype html>
<html><head><title>Только для подписчиков</title></head>
<body><div class="paywall"><p>Подпишитесь, чтобы читать.</p></div></body></html>`;

/** Блог на div-ах без единого тега <p>. */
export const DIV_ONLY_HTML = `<!doctype html>
<html><head><title>Заметка без абзацев</title></head>
<body><div class="content"><div>${LEAD}</div><div>${BODY}</div></div></body></html>`;

/** Сущности HTML и типографика в тексте статьи. */
export const ENTITIES_HTML = `<!doctype html>
<html><head><title>Сущности&nbsp;и&nbsp;кавычки</title></head>
<body><article><p>Сервис назвали &laquo;Gemini&raquo; &mdash; и это важно для читателя,
который ищет ответ на вопрос &quot;что мне с этого&quot;, а не пресс-релиз целиком.</p>
<p>${BODY}</p></article></body></html>`;

export const FIXTURE_LEAD = LEAD;
export const FIXTURE_BODY = BODY;
