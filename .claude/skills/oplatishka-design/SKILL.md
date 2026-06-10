---
version: 0.1.0
name: oplatishka-design
description: >
  Design system and brand rules for the "Оплатишка" website — a comic-companion
  chat UI (pop-art / halftone, living mascot host). Use when building or styling
  ANY part of apps/web: chat bubbles, mascot states, service cards, order panel,
  the "ОПЛАЧЕНО" stamp, quick-reply chips, buttons, layout, themes, colors,
  typography, motion; OR when generating on-brand assets (mascot poses/emotions,
  backgrounds, card frames, favicon/OG) via Higgsfield. Triggers on: "стиль сайта",
  "дизайн чата", "брендовые цвета/токены", "оживить маскота", "комикс-карточки",
  "сгенерировать ассет Оплатишки", "halftone", "speech bubble". NOT for: backend
  contracts / streaming / anti-abuse (see docs/web-chat.md), AI prompt behavior
  (docs/ai-agent.md), or generic Higgsfield jobs unrelated to this brand.
argument-hint: "[what to design or generate] (e.g. 'order card', 'mascot thinking pose')"
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

# Оплатишка — Design System

Реализационные правила бренда для сайта (`apps/web`). Это **как делать**; полная концепция и фазы — в [`docs/web-design.md`](../../../docs/web-design.md), функциональные контракты — в [`docs/web-chat.md`](../../../docs/web-chat.md). При конфликте по поведению/контрактам побеждает `web-chat.md`.

## Суть бренда за 20 секунд

«Оплатишка» — дружелюбный гик в очках и бирюзовом худи, который оплатит любую иностранную подписку. Сайт = **разговор с персонажем**, не форма. Язык — **комикс/поп-арт**: жирные контуры, halftone-точки, стикерная обводка, речь в облаках, жёсткие тени без размытия, платёж как кульминация (штамп «ОПЛАЧЕНО» + конфетти).

Исходные ассеты бренда: `content_site/` (2 лого + видео-маскот 5 сек). Палитра в токенах снята **прямо из них**.

## Hard rules (не нарушать)

1. **Тёмная тема по умолчанию** («комикс-нуар», фон `--noir #0F0D11`). Светлая — тумблер в шапке (реализован).
2. **AI-текст — лёгкое форматирование (RichText): абзацы, списки `- `/`1.`, `**bold**`, автолинк.** НЕ полный markdown (без заголовков/таблиц/HTML). Богатый контент — только через tool-карточки.
3. **Деньги показываем в рублях, форматировано** (суммы в БД — копейки; форматировать на отображении).
4. **Никаких клиентских секретов** — AI/БД только через server route.
5. **`prefers-reduced-motion`** — отключать idle-цикл маскота, конфетти, slam; показывать статичную позу.
6. **Эмодзи запрещены в коде/комментариях/логах.** В UI-строках на русском — только если требует продукт (по согласованию).
7. **Кириллица обязательна** во всех шрифтах (Balsamiq Sans + Rubik). Не подключать комикс-фонты без кириллицы для русского текста (Baloo 2 отклонён именно по этой причине).
8. **Сигнатура стиля = жёсткая тень `4px 4px 0 var(--ink)` + контур `2.5px solid var(--ink)`.** Без них элемент «выпадает» из комикса. Не заменять на мягкие blur-тени.
9. **Один видимый маскот на экране** (фидбек владельца): крупный в правой панели (`lg+`) или компактный в шапке (`<lg`). Без аватаров у реплик/в навбаре. Ассет — прозрачный PNG («стикер»), без рамок/тёмных плашек; объём — drop-shadow по силуэту. Живость — микро-анимации поз (bob/think/cheer), не дубли картинки.

## Токены (быстрый якорь)

Полные таблицы и CSS — в [`references/design-tokens.md`](references/design-tokens.md). Ключевое:

- **Teal:** primary `#268B89`, light `#5B9C99`, deep `#306874`
- **Ink:** `#16151A` · **Paper/cream:** `#FBFCF7` · **Noir bg:** `#0F0D11`
- **Акценты:** brown `#6E4E4C`, glasses-blue `#2E3A8C`, skin `#E7C1A9`, stamp-red `#C2362F`
- **Шрифты:** Balsamiq Sans 400/700 (display/штампы/кнопки; НЕ использовать `font-extrabold` — у шрифта нет 800) · Rubik (body/UI). История: Baloo 2 отклонён (нет кириллицы) → Nunito → Balsamiq Sans по фидбеку владельца
- **Тень:** `--shadow-comic: 4px 4px 0 var(--ink)` · **контур:** `--border-comic: 2.5px solid var(--ink)`
- **Радиусы:** карточки 16–20px, облака — крупные асимметричные

## Компоненты

Анатомия и разметка комикс-облаков, карточек сервисов, панели заказа, штампа «ОПЛАЧЕНО», quick-reply чипов, состояний маскота — в [`references/components.md`](references/components.md). Маппинг tool-call → UI там же.

## Маскот — состояния

Персонаж реагирует на ход диалога: `idle/wave` → `thinking` (стрим) → `presenting` (каталог) → `celebrate` (оплата). Таблица состояний и ассетов — в `docs/web-design.md` §6 и [`references/brand.md`](references/brand.md).

## Генерация ассетов (Higgsfield)

Этот скилл **не дёргает CLI напрямую** — он даёт on-brand рецепты, а исполнение делегирует скиллам `higgsfield-generate` / `higgsfield-product-photoshoot`. Готовые промпт-рецепты (позы маскота, halftone-фоны, рамки карточек, favicon/OG) + правила консистентности (image-to-image от исходного маскота) — в [`references/higgsfield-recipes.md`](references/higgsfield-recipes.md).

Базовый воркфлоу:
1. `higgsfield account status` — проверить сессию (если упало — попросить `higgsfield auth login`).
2. Брать рецепт из `higgsfield-recipes.md`, подставлять `--image content_site/<кадр>.jpg` для консистентности лица/стиля.
3. `higgsfield generate create gpt_image_2 --prompt "<рецепт>" --image <path> --wait` → вернуть URL ассета.
4. Скачать, оптимизировать, положить в `apps/web/public/`; исходники — в `content_site/`.

## Чек-лист перед сдачей UI-куска

- [ ] Контур + жёсткая тень на интерактиве/карточках/облаках
- [ ] Halftone только под крупными зонами, не под мелким текстом
- [ ] Контраст AA (текст поверх teal/halftone)
- [ ] Хвост облака с правильной стороны (user — справа, бот — слева)
- [ ] `prefers-reduced-motion` обработан
- [ ] Цвета/радиусы/шрифты — только из токенов, без magic-значений
- [ ] Mobile-first, `100dvh`, безопасные зоны iOS
- [ ] `pnpm typecheck && pnpm lint` зелёные
