# Higgsfield-рецепты — ассеты Оплатишки

Готовые промпт-рецепты для генерации on-brand ассетов. **Исполнение делегируется** скиллам `higgsfield-generate` (универсальное) / `higgsfield-product-photoshoot` (брендовые сцены) — этот файл даёт промпты и правила, не дублирует CLI.

## Главное правило: консистентность

Маскот уже существует. Любую новую позу/эмоцию генерировать **image-to-image от исходника**, а не с нуля — иначе лицо «поплывёт».

Исходные кадры (положить пути относительно корня репо):
- `content_site/2026-06-09 21.53.59.jpg` — портрет (голова+плечи), лого-стиль.
- `content_site/2026-06-09 21.53.52.jpg` — портрет, подмигивает.
- Кадр видео в полный рост — извлечь: `ffmpeg -i "content_site/2026-06-09 21.52.41.mov" -frames:v 1 /tmp/mascot_full.jpg` (используй полноростовой кадр для поз тела).

Воркфлоу:
```bash
higgsfield account status                      # сессия жива? иначе: higgsfield auth login
higgsfield generate create gpt_image_2 \
  --prompt "<рецепт ниже>" \
  --image "content_site/2026-06-09 21.53.52.jpg" \
  --wait
```
`--image` принимает локальный путь (автозагрузка) или upload-id. Для серии поз — один раз `higgsfield upload create <файл>`, дальше переиспользовать id.

## Общий стилевой суффикс (добавлять к каждому промпту)

> `same character: young man with reddish-brown wavy hair, round blue glasses, teal hoodie; comic / pop-art style, bold black outlines, halftone dot shading, cream sticker outline; full character visible, centered; consistent with reference image`

**Канон фона (фидбек владельца 2026-06-09): позы маскота — ТОЛЬКО с прозрачным фоном** («стикер» без тёмной плашки). Добавлять к промпту: `isolated on transparent background, no background, sticker style cutout`. Если модель вернула фон — снять локально (rembg/Vision) перед укладкой в `public/mascot/`. Тёмный фон `#0F0D11` оставлять только для полноэкранных сцен (OG-баннер и т.п.).

## Рецепты — позы маскота (image-to-image, портрет или полный рост)

| Ключ | Prompt core (+ стилевой суффикс) |
|---|---|
| `wave` | `the character smiling and waving one hand in friendly greeting` |
| `thinking` | `the character looking up thoughtfully, one finger on chin, curious expression` |
| `presenting` | `the character gesturing with open hand to the side, presenting something, light smile` |
| `celebrate` | `the character cheering with both arms raised, big happy smile, triumphant jump pose` |
| `handoff` | `the character with a calm reassuring expression, one hand extended forward as if handing over` |
| `oops` | `the character with a sheepish apologetic smile, hand scratching the back of head` |

Совет: для слота-аватара в шапке генерь **портрет** (от `21.53.52.jpg`); для боковой колонки на десктопе — **полный рост** (от кадра видео).

## Рецепты — окружение и графика

| Ассет | Подход | Prompt / приём |
|---|---|---|
| Halftone-фон (tileable) | `gpt_image_2`, без референса | `seamless tileable pop-art halftone dot texture, dark teal on near-black #0F0D11, subtle, high-res` — либо проще **чистым CSS** (см. `.halftone` в design-tokens.md) |
| Рамка карточки сервиса | обычно CSS (контур+тень), Higgsfield не нужен | — |
| Favicon / app icon | от лого-портрета | `app icon, head of the character, round blue glasses, teal hoodie, bold comic outline, simple, centered, on #0F0D11` → экспорт 512/192/32 |
| OG-картинка (1200×630) | `product-photoshoot` (`hero_banner`) или `gpt_image_2` | `social share banner, the Оплатишка character on the left waving, bold cream wordmark space on the right, pop-art halftone, teal + cream on dark` |

## Видео (доп. idle/celebrate клипы — backlog)

Для коротких анимаций состояний — image-to-video от сгенерированной позы (модель Seedance/Kling через `higgsfield-generate`):
```bash
higgsfield generate create <video_model> \
  --prompt "subtle idle breathing loop, character winks occasionally, minimal motion, seamless loop" \
  --start-image <pose_upload_id> --wait --wait-timeout 20m
```
Держать короткими (2–4 сек), seamless loop, лёгкое движение — иначе тяжело для мобилы.

## Гигиена ассетов

- Генерировать пакетно (все позы за подход), переиспользовать upload-id.
- Скачивать → оптимизировать (WebP/AVIF для статики, mp4/webm h.264/vp9 для видео) → класть в `apps/web/public/mascot/`.
- Исходники (сырьё, psd-подобное) — в `content_site/`, не в `public/`.
- Higgsfield платный — не перегенерировать уже готовое; не оценивать стоимость заранее, если владелец не просил, но не лить лишних джоб.
- Проверять кадр на дрейф лица/цвета худи против референса перед использованием.
