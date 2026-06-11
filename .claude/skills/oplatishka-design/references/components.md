# Компоненты — Оплатишка comic UI

Анатомия ключевых элементов чата. Все используют сигнатуру: контур `--border-comic` + жёсткая тень `--shadow-comic`. Маппинг tool-call → UI описан здесь; фактический контракт ответа агента (toolCalls в JSON) — `apps/web/app/api/chat/route.ts`.

## 1. Комикс-облако (speech bubble)

Реплика в облаке с хвостиком. У пользователя хвост справа (teal-заливка), у Оплатишки — слева (тёмный teal-tint на dark).

```tsx
// Бот (хвост слева). Контент — через RichText (абзацы, списки, **bold**, автолинк; НЕ полный markdown).
<div className="relative max-w-[78%] self-start font-body text-[var(--text)]
                bg-[var(--bubble-bot)] border-[2.5px] border-[var(--shadow-ink)]
                rounded-[var(--radius-bubble)] rounded-bl-[6px]
                shadow-[var(--shadow-comic)] px-4 py-3">
  {linkify(text)}
  {/* хвост: маленький треугольник через ::before/clip-path или абсолютный div */}
  <span aria-hidden className="absolute -left-[9px] bottom-2 h-3 w-3
        bg-[var(--bubble-bot)] border-l-[2.5px] border-b-[2.5px] border-[var(--shadow-ink)]
        [clip-path:polygon(0_100%,100%_100%,100%_0)] rotate-45" />
</div>
```

User-облако — `self-end`, `bg-[var(--bubble-user)]`, `rounded-br-[6px]`, хвост справа (`-right`).

Появление: `opacity 0→1`, `translateY 8px→0`, `scale .96→1`, `--ease-pop`, 180ms.

## 2. Typing-облако («Оплатишка думает…»)

Облако бота с тремя прыгающими точками. Синхронно маскот уходит в позу `thinking` (см. brand.md).

```tsx
<div className="flex gap-1 px-4 py-3 ...bubble-bot styles...">
  {[0,1,2].map(i => (
    <span key={i} className="h-2 w-2 rounded-full bg-[var(--text-muted)]
      motion-safe:animate-bounce" style={{ animationDelay: `${i*0.15}s` }} />
  ))}
</div>
```

## 3. Карточка сервиса (`search_catalog`)

Колода карточек: лого сервиса, название, тариф, период, цена в ₽. Появляются каскадом с лёгким флипом (`rotateY`).

```
┌───────────────────────┐   контур + shadow-comic
│  [logo]  Spotify       │
│  ─────────────────     │   halftone-полоска
│  Premium · 1 мес       │
│  399 ₽           [→]   │   цена крупно font-display
└───────────────────────┘
```
- Лого сервиса — на нейтральной плашке (контраст к teal).
- Цена — `font-display`, акцент.
- Hover: подъём (`translateY -2px`, тень растёт до `--shadow-comic-lg`).
- Клик/кнопка → отправляет в чат «Хочу <сервис> <тариф>» (ведёт к `propose_order`).
- Каскад: `staggerChildren: 0.06`, флип `rotateY 12deg→0`.

## 4. Панель заказа (`propose_order`)

Комикс-панель (крупнее карточки): сервис, тариф, период, регион/KYC если есть, **сумма в ₽**, кнопка «Подтвердить» (главная) + «Изменить».

```
╔═══════════════════════════╗  shadow-comic-lg
║  ЗАКАЗ                     ║  font-display заголовок
║  Claude Pro · 1 мес        ║
║  Регион: US                ║
║  ─────────────────────     ║
║  К оплате:   1 990 ₽       ║  крупно, акцент
║  [ Подтвердить ]  Изменить ║
╚═══════════════════════════╝
```
- «Подтвердить» — главный CTA (комикс-кнопка, `bg-accent`), вдавливается при нажатии.
- Сумма форматируется (`Intl.NumberFormat('ru-RU')`), копейки из БД → рубли.

## 5. Блок оплаты + штамп «ОПЛАЧЕНО» (`confirm_order` → webhook `paid`)

Сначала — платёжная ссылка/кнопка («Оплатить» → провайдер). После подтверждения оплаты (realtime/poll статуса) — **slam-штамп** поверх панели заказа + конфетти + маскот в позе `celebrate`.

```tsx
// Штамп: появляется крупным, "впечатывается" с поворотом и оверштутом
<motion.div
  initial={{ scale: 2.4, opacity: 0, rotate: -18 }}
  animate={{ scale: 1, opacity: 1, rotate: -12 }}
  transition={{ type: "spring", stiffness: 700, damping: 18 }}
  className="font-display font-extrabold text-[var(--color-stamp)]
             border-[4px] border-[var(--color-stamp)] rounded-[10px]
             px-4 py-1 tracking-wider uppercase select-none">
  Оплачено
</motion.div>
```
- Штамп — классический «резиновый» вид: stamp-red, толстый контур, лёгкий поворот, чуть «затёртый» (можно `mix-blend` / лёгкая halftone-маска).
- Конфетти — `canvas-confetti` цветами бренда (teal/paper/brown), однократно; уважать `prefers-reduced-motion`.

## 6. Quick-reply чипы

**УБРАНЫ из чата по фидбеку владельца (2026-06-09).** Компонент `QuickReplyChip` сохранён в барреле `components/comic` (используется на `/styleguide`); в боевом чате не размещать без нового решения владельца.

```tsx
<button className="font-body text-sm whitespace-nowrap rounded-full
  border-[2px] border-[var(--shadow-ink)] bg-[var(--surface)] text-[var(--text)]
  shadow-[2px_2px_0_var(--shadow-ink)] active:translate-x-[2px] active:translate-y-[2px]
  active:shadow-none px-3 py-1.5">
  Хочу Spotify
</button>
```
Горизонтальный скролл на мобиле (`overflow-x-auto`, скрытый скроллбар).

## 7. Поле ввода

Авторазмер `<textarea>`, Enter — отправка, Shift+Enter — перенос, лимит 4000 символов, `aria-label`. Кнопка отправки — круглая комикс-кнопка с иконкой `→`.

## 8. Шапка

«Оплатишка» (`font-display`) + статус-точка (online = `--success`, оператор = stamp-red, пульсация) + кнопка «Очистить диалог» (POST /api/chat/clear → новый conversation, история в БД сохраняется) + тумблер темы. Кнопки «Позвать оператора» НЕТ (убрана по фидбеку владельца) — эскалация запросом в чате, `request_human` вызывает агент. Маскот в шапке — только `<lg` (правило одного маскота, SKILL.md §9). Скроллбары ленты/textarea — класс `.comic-scroll` (teal-таблетка с контуром), не стандартные.

## 9. Баннеры состояний (из `web-chat.md` §Состояния)

- Ошибка Anthropic: «Технические проблемы. Попробуйте через минуту» (нейтральный, stamp-red акцент).
- Rate-limit: блок ввода + таймер.
- Handoff активен: «Оператор подключён» (статус в шапке → stamp-red), маскот в позе `handoff`, ввод работает (идёт оператору).

## Маппинг tool-call → UI (сводка)

| Tool | UI | Маскот |
|---|---|---|
| (текст) | комикс-облако бота | idle / лёгкая реакция |
| `search_catalog` | колода карточек сервисов | `presenting` |
| `propose_order` | панель заказа + «Подтвердить» | idle |
| `confirm_order` | блок оплаты → (paid) штамп + конфетти | `celebrate` |
| `request_human` | статус «оператор», баннер handoff | `handoff` |
