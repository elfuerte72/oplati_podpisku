# Design tokens — Оплатишка

Палитра снята из ассетов (`content_site/`: лого + кадры видео-маскота) через ffmpeg `palettegen`. Это не «на глаз» — это реальные цвета бренда. Используй **только токены**, без magic-значений в компонентах.

## Палитра (raw, из ассетов)

| Токен | HEX | Источник | Назначение |
|---|---|---|---|
| `teal-primary` | `#268B89` | худи (мид) | основной бренд-цвет, user-облако, акценты |
| `teal-light` | `#5B9C99` | худи (светлый) | акцент на dark, hover |
| `teal-deep` | `#306874` | лого | акцент на light, глубина |
| `teal-tint` | `#455F5F` | худи (тень) | приглушённые зоны |
| `ink` | `#16151A` | контуры (`#0F0D11`/`#1D1A1D`) | контуры, тени, текст на light |
| `paper` | `#FBFCF7` | заливка wordmark | фон light, текст на dark, стикер-обводка |
| `noir` | `#0F0D11` | фон видео/лого | фон dark-темы |
| `brown` | `#6E4E4C` | волосы | вторичный акцент |
| `skin` | `#E7C1A9` | кожа | иллюстративные детали |
| `glasses-blue` | `#2E3A8C` | очки | ссылки, info-акцент |
| `stamp-red` | `#C2362F` | — (классич. штамп) | «ОПЛАЧЕНО», ошибки/деструктив |
| `success` | `#2FA39E` | производный teal | успех/online |

## Семантические токены

### Dark (по умолчанию — «комикс-нуар»)
| Семантика | Значение |
|---|---|
| `--bg` | `#0F0D11` (noir) |
| `--surface` | `#1A1A20` |
| `--surface-2` | `#23232B` |
| `--text` | `#FBFCF7` (paper) |
| `--text-muted` | `#A9A7AE` |
| `--accent` | `#5B9C99` (teal-light) |
| `--bubble-bot` | `#1F2A2A` (тёмный teal-tint) |
| `--bubble-user` | `#268B89` (teal-primary) |
| `--ink` | `#0B0A0D` (ещё темнее для контура на тёмном) |
| `--link` | `#7E8BE0` (осветлённый glasses-blue для контраста) |

### Light («бумажный комикс» — backlog/тумблер)
| Семантика | Значение |
|---|---|
| `--bg` | `#FBFCF7` (paper) |
| `--surface` | `#FFFFFF` |
| `--text` | `#16151A` (ink) |
| `--accent` | `#306874` (teal-deep) |
| `--bubble-bot` | `#FFFFFF` |
| `--bubble-user` | `#5B9C99` |
| `--ink` | `#16151A` |
| `--link` | `#2E3A8C` (glasses-blue) |

## Не-цветовые токены

| Токен | Значение | Заметка |
|---|---|---|
| `--shadow-comic` | `4px 4px 0 var(--ink)` | **сигнатура**, без blur |
| `--shadow-comic-lg` | `6px 6px 0 var(--ink)` | крупные панели |
| `--border-comic` | `2.5px solid var(--ink)` | контур карточек/облаков/кнопок |
| `--radius-card` | `18px` | карточки/панели |
| `--radius-bubble` | `22px` (с одним «сжатым» углом у хвоста) | речь-облака |
| `--radius-chip` | `999px` | quick-reply чипы |
| `--font-display` | `Balsamiq Sans (400/700), system-ui` | заголовки, имя маскота, штампы, кнопки. Макс. вес 700 — `font-extrabold` запрещён (синтетика размывает контур). История: Baloo 2 (нет кириллицы) → Nunito → Balsamiq Sans (фидбек владельца) |
| `--font-body` | `Rubik, system-ui` | UI/текст (заменил Manrope — скруглённые углы под комикс-вайб) |
| `--halftone-dot` | `2px` | размер точки паттерна |
| `--halftone-gap` | `7px` | шаг точек |
| `--ease-pop` | `cubic-bezier(.2,.9,.25,1.3)` | overshoot-появления |

## Готовый CSS (Tailwind v4 `@theme` в `apps/web/app/globals.css`)

```css
@import "tailwindcss";

@theme {
  /* brand raw */
  --color-teal-primary: #268B89;
  --color-teal-light:   #5B9C99;
  --color-teal-deep:    #306874;
  --color-ink:          #16151A;
  --color-paper:        #FBFCF7;
  --color-noir:         #0F0D11;
  --color-brown:        #6E4E4C;
  --color-glasses:      #2E3A8C;
  --color-skin:         #E7C1A9;
  --color-stamp:        #C2362F;

  --font-display: var(--font-display-src), system-ui, sans-serif; /* Balsamiq Sans через next/font */
  --font-body:    var(--font-body-src), system-ui, sans-serif;    /* Rubik через next/font */

  --radius-card:   18px;
  --radius-bubble: 22px;

  --ease-pop: cubic-bezier(.2,.9,.25,1.3);
}

:root {
  /* dark = default */
  --bg: #0F0D11;
  --surface: #1A1A20;
  --surface-2: #23232B;
  --text: #FBFCF7;
  --text-muted: #A9A7AE;
  --accent: #5B9C99;
  --bubble-bot: #1F2A2A;
  --bubble-user: #268B89;
  --shadow-ink: #0B0A0D;
  --link: #7E8BE0;

  --shadow-comic: 4px 4px 0 var(--shadow-ink);
  --shadow-comic-lg: 6px 6px 0 var(--shadow-ink);
  --border-comic: 2.5px solid var(--shadow-ink);
}

[data-theme="light"] {
  --bg: #FBFCF7;
  --surface: #FFFFFF;
  --surface-2: #F1F2EC;
  --text: #16151A;
  --text-muted: #5B5A60;
  --accent: #306874;
  --bubble-bot: #FFFFFF;
  --bubble-user: #5B9C99;
  --shadow-ink: #16151A;
  --link: #2E3A8C;
}

/* Сигнатурная halftone-фактура: точечный паттерн поверх зоны */
.halftone {
  background-image: radial-gradient(var(--ink-dot, rgba(0,0,0,.18)) 2px, transparent 2px);
  background-size: 7px 7px;
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
```

Шрифты подключать через `next/font/google` (`Balsamiq_Sans` weight 400/700, `Rubik`) с `subsets: ["cyrillic", "latin"]` и `variable: "--font-display-src"` / `"--font-body-src"` — **обязательно `cyrillic`**. Baloo 2 кириллицу не покрывает — отклонён.

## Tailwind-утилиты (примеры применения)

```tsx
// Комикс-кнопка
className="font-display font-bold text-[var(--text)] bg-[var(--accent)]
           rounded-[var(--radius-card)] border-[2.5px] border-[var(--shadow-ink)]
           shadow-[var(--shadow-comic)] active:translate-x-[2px] active:translate-y-[2px]
           active:shadow-none transition-[transform,box-shadow] px-5 py-3"
```

Нажатие «вдавливает» кнопку (сдвиг на величину тени + снятие тени) — фирменный тактильный отклик поп-арта.
