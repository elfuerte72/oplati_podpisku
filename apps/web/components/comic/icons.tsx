// Набор SVG-иконок в комикс-стиле «Оплатишки»: толстый округлый контур,
// наследование цвета через currentColor. Иконки декоративные (aria-hidden).
// Единый стиль для всех — общие атрибуты вынесены в BASE_SVG_PROPS.
// Каждая иконка умещается в viewBox 0..24 с отступом ~2px от краёв.

export type IconProps = {
  className?: string;
  size?: number;
};

// Общие атрибуты обводки. `as const` даёт литеральные типы,
// совместимые с SVGProps при spread'е (без внешних импортов).
const BASE_SVG_PROPS = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2.2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
  focusable: 'false',
} as const;

/** Корзина покупок — тележка на двух колёсах. */
export function IconCart({ className, size = 20 }: IconProps) {
  return (
    <svg {...BASE_SVG_PROPS} className={className} width={size} height={size}>
      <circle cx="9" cy="20" r="1.4" />
      <circle cx="18" cy="20" r="1.4" />
      <path d="M2.5 3.5h2.2l2.5 11.2a1.7 1.7 0 0 0 1.66 1.3h8.2a1.7 1.7 0 0 0 1.66-1.28l1.55-6.94H6.2" />
    </svg>
  );
}

/** Два человечка — партнёрство / «зови друзей». */
export function IconUsers({ className, size = 20 }: IconProps) {
  return (
    <svg {...BASE_SVG_PROPS} className={className} width={size} height={size}>
      <circle cx="9" cy="7.5" r="3.4" />
      <path d="M3 20v-1.4a5 5 0 0 1 5-5h2a5 5 0 0 1 5 5V20" />
      <path d="M16.5 4.4a3.4 3.4 0 0 1 0 6.5" />
      <path d="M17.5 13.4a5 5 0 0 1 3.5 4.8V20" />
    </svg>
  );
}

/** Галочка — «готово» / «скопировано». */
export function IconCheck({ className, size = 20 }: IconProps) {
  return (
    <svg {...BASE_SVG_PROPS} className={className} width={size} height={size}>
      <path d="M5 13l4 4 10-10" />
    </svg>
  );
}

/** Стрелка назад (влево). */
export function IconArrowLeft({ className, size = 20 }: IconProps) {
  return (
    <svg {...BASE_SVG_PROPS} className={className} width={size} height={size}>
      <path d="M19 12H5" />
      <path d="M11 6l-6 6 6 6" />
    </svg>
  );
}

/** Стрелка вперёд (вправо). */
export function IconArrowRight({ className, size = 20 }: IconProps) {
  return (
    <svg {...BASE_SVG_PROPS} className={className} width={size} height={size}>
      <path d="M5 12h14" />
      <path d="M13 6l6 6-6 6" />
    </svg>
  );
}

/** Стрелка вверх — «вывод средств» в истории. */
export function IconArrowUp({ className, size = 20 }: IconProps) {
  return (
    <svg {...BASE_SVG_PROPS} className={className} width={size} height={size}>
      <path d="M12 19V5" />
      <path d="M6 11l6-6 6 6" />
    </svg>
  );
}

/** Домик — дашборд. */
export function IconHome({ className, size = 20 }: IconProps) {
  return (
    <svg {...BASE_SVG_PROPS} className={className} width={size} height={size}>
      <path d="M3 11.5L12 4l9 7.5" />
      <path d="M5.5 10v9.5a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V10" />
      <path d="M9.5 20.5v-6h5v6" />
    </svg>
  );
}

/** Лампочка — подсказка «как это работает». */
export function IconBulb({ className, size = 20 }: IconProps) {
  return (
    <svg {...BASE_SVG_PROPS} className={className} width={size} height={size}>
      <path d="M8 10.5a4 4 0 1 1 8 0c0 1.6-.9 2.6-1.6 3.3-.5.5-.9 1-.9 1.7h-3c0-.7-.4-1.2-.9-1.7C8.9 13.1 8 12.1 8 10.5Z" />
      <path d="M9.5 18h5" />
      <path d="M10.5 20.5h3" />
    </svg>
  );
}

/** Язык пламени — бейдж статуса. */
export function IconFire({ className, size = 20 }: IconProps) {
  return (
    <svg {...BASE_SVG_PROPS} className={className} width={size} height={size}>
      <path d="M12 3.5c.4 2.3 1.9 4.2 3.6 5.7 1.7 1.4 2.9 3.2 2.9 5.3a6.5 6.5 0 0 1-13 0c0-1 .4-2 1-2.8a2.4 2.4 0 0 0 4.2-1.5c0-1.2-.5-1.8-1-2.7C8.9 6.6 9.6 4.9 12 3.5Z" />
    </svg>
  );
}

/** Столбчатый график — ставка / статистика. */
export function IconChart({ className, size = 20 }: IconProps) {
  return (
    <svg {...BASE_SVG_PROPS} className={className} width={size} height={size}>
      <path d="M3.5 20.5h17" />
      <path d="M6.8 20.5V15.5a1 1 0 0 1 1-1h.4a1 1 0 0 1 1 1V20.5" />
      <path d="M10.8 20.5V11.5a1 1 0 0 1 1-1h.4a1 1 0 0 1 1 1V20.5" />
      <path d="M14.8 20.5V7.5a1 1 0 0 1 1-1h.4a1 1 0 0 1 1 1V20.5" />
    </svg>
  );
}

/** Монета с рублём — общий доход. */
export function IconMoney({ className, size = 20 }: IconProps) {
  return (
    <svg {...BASE_SVG_PROPS} className={className} width={size} height={size}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M10.3 16.5V8h2.7a2.5 2.5 0 0 1 0 5H9.2" />
    </svg>
  );
}

/** Подарочная коробка с бантом — бонус. */
export function IconGift({ className, size = 20 }: IconProps) {
  return (
    <svg {...BASE_SVG_PROPS} className={className} width={size} height={size}>
      <rect x="3.5" y="7.5" width="17" height="4" rx="1" />
      <path d="M5 11.5v7.5a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5v-7.5" />
      <path d="M12 7.5v13" />
      <path d="M12 7.5C11 5.5 9.5 3.5 7.8 3.5a2 2 0 0 0 0 4H12" />
      <path d="M12 7.5C13 5.5 14.5 3.5 16.2 3.5a2 2 0 0 1 0 4H12" />
    </svg>
  );
}

/** Замок закрытый — «навсегда» / максимум. */
export function IconLock({ className, size = 20 }: IconProps) {
  return (
    <svg {...BASE_SVG_PROPS} className={className} width={size} height={size}>
      <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
      <circle cx="12" cy="14.8" r="1.1" />
      <path d="M12 15.6v2.2" />
    </svg>
  );
}

/** Молния — спринт. */
export function IconBolt({ className, size = 20 }: IconProps) {
  return (
    <svg {...BASE_SVG_PROPS} className={className} width={size} height={size}>
      <path d="M13 3L4.5 13.5H11.5L11 21l8.5-10.5H12.5L13 3Z" />
    </svg>
  );
}

/** Бумажный самолётик — поделиться в Telegram. */
export function IconSend({ className, size = 20 }: IconProps) {
  return (
    <svg {...BASE_SVG_PROPS} className={className} width={size} height={size}>
      <path d="M21 3L3 9.5l7.5 4L14 21 21 3Z" />
      <path d="M21 3l-10.5 10.5" />
    </svg>
  );
}

/** Звенья цепи — ссылка / привязка. */
export function IconLink({ className, size = 20 }: IconProps) {
  return (
    <svg {...BASE_SVG_PROPS} className={className} width={size} height={size}>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

/** Пятиконечная звезда — аватар статуса. */
export function IconStar({ className, size = 20 }: IconProps) {
  return (
    <svg {...BASE_SVG_PROPS} className={className} width={size} height={size}>
      <path d="M12 3L14.78 8.63 21 9.54l-4.5 4.39 1.06 6.19L12 17.19l-5.56 2.93L7.5 13.93 3 9.54l6.22-.91Z" />
    </svg>
  );
}

/** Две наложенные карточки — копировать. */
export function IconCopy({ className, size = 20 }: IconProps) {
  return (
    <svg {...BASE_SVG_PROPS} className={className} width={size} height={size}>
      <rect x="8.5" y="8.5" width="12" height="12" rx="2.5" />
      <path d="M15.5 5.5V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8.5a2 2 0 0 0 2 2h.5" />
    </svg>
  );
}
