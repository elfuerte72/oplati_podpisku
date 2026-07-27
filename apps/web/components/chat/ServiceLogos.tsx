import Image from 'next/image';
import type { SimpleIcon } from 'simple-icons';
import {
  siAirbnb,
  siApple,
  siApplemusic,
  siAppstore,
  siBookingdotcom,
  siClaude,
  siCursor,
  siDiscord,
  siIcloud,
  siNetflix,
  siNotion,
  siPlaystation,
  siSpotify,
  siSteam,
  siSuno,
  siTelegram,
  siTinder,
  siYoutube,
  siZoom,
} from 'simple-icons';

/**
 * Логотипы сервисов витрины. Для брендов, где важна точная форма/цвет,
 * используем подготовленные bitmap assets из public/service-icons.
 *
 * Формат — WebP, lossless, 256×256 (на витрине рисуется 26px, запас на retina
 * и на карточки покрупнее). Перевод с PNG 2026-07-27 срезал вес пачки вдвое,
 * 235 КБ → 136 КБ; lossless выбран потому, что у логотипов резкие края и
 * артефакты на них заметнее, чем экономия ещё пары килобайт.
 *
 * ⚠️ В WebP переводятся ТОЛЬКО браузерные картинки. НЕ трогать:
 *   - `public/vpn/happ-step-*.jpg` — их скачивает по ссылке Telegram для
 *     sendMediaGroup, а Bot API принимает фото в JPEG; WebP он либо отвергнет,
 *     либо примет как стикер, и инструкция по VPN перестанет доходить;
 *   - `app/apple-icon.png`, `app/icon.png`, `favicon.ico` — apple-touch-icon и
 *     favicon в WebP не поддерживает Safari.
 */
type ServiceIcon = SimpleIcon | { path: string; hex: string };

const IMAGE_LOGOS: Record<string, string> = {
  'chatgpt-plus': '/service-icons/openai.webp',
  'midjourney-basic': '/service-icons/midjourney.webp',
  'adobe-creative-cloud': '/service-icons/adobe-creative-cloud.webp',
  'figma-professional': '/service-icons/figma.webp',
  'gemini-advanced': '/service-icons/gemini.webp',
  'grok-pro': '/service-icons/grok.webp',
  higgsfield: '/service-icons/higgsfield.webp',
  heygen: '/service-icons/heygen.webp',
  'linkedin-premium': '/service-icons/linkedin.webp',
  'perplexity-pro': '/service-icons/perplexity.webp',
};

const xboxGlyph: ServiceIcon = {
  hex: '107C10',
  path: 'M12 2.5c2.1 0 4.05.68 5.63 1.84-2.19.2-4.12 1.21-5.63 2.74-1.51-1.53-3.44-2.54-5.63-2.74A9.43 9.43 0 0 1 12 2.5Zm-7.1 3.2c2.18.1 4.16 1.05 5.68 2.6-1.86 2.31-3.05 5.3-3.38 8.46-1.75-1.73-2.84-4.13-2.84-6.78 0-1.55.37-3.02 1.04-4.28Zm14.2 0c.67 1.26 1.04 2.73 1.04 4.28 0 2.65-1.09 5.05-2.84 6.78-.33-3.16-1.52-6.15-3.38-8.46 1.52-1.55 3.5-2.5 5.68-2.6ZM12 9.77c2.07 2.47 3.27 5.85 3.34 9.34A9.43 9.43 0 0 1 12 19.7a9.43 9.43 0 0 1-3.34-.59c.07-3.49 1.27-6.87 3.34-9.34Z',
};

const LOGOS: Record<string, ServiceIcon> = {
  'claude-pro': siClaude,
  'netflix-premium': siNetflix,
  'spotify-premium': siSpotify,
  airbnb: siAirbnb,
  'youtube-premium': siYoutube,
  'discord-nitro': siDiscord,
  'apple-one': siApple,
  'apple-app-store': siAppstore,
  'icloud-plus-200gb': siIcloud,
  'apple-music': siApplemusic,
  'notion-plus': siNotion,
  'cursor-pro': siCursor,
  suno: siSuno,
  'playstation-plus': siPlaystation,
  'xbox-game-pass': xboxGlyph,
  steam: siSteam,
  booking: siBookingdotcom,
  'telegram-premium': siTelegram,
  tinder: siTinder,
  'zoom-pro': siZoom,
};

type ServiceLogoProps = {
  slug: string;
  name: string;
  size?: number;
};

/**
 * Глиф логотипа (без плашки — её рисует родитель). Тёмные фирменные цвета
 * (#000 у Apple/Notion) рассчитаны на светлую плашку — родитель обязан давать
 * светлый фон в обеих темах.
 */
export function ServiceLogo({ slug, name, size = 26 }: ServiceLogoProps) {
  const imageSrc = IMAGE_LOGOS[slug];
  if (imageSrc) {
    return (
      <Image
        src={imageSrc}
        alt=""
        width={size}
        height={size}
        unoptimized
        draggable={false}
        aria-hidden
        style={{ width: size, height: size, objectFit: 'contain' }}
      />
    );
  }

  const icon = LOGOS[slug];
  if (!icon) {
    return (
      <span aria-hidden className="font-display text-xl font-bold text-[var(--color-ink)]">
        {name.slice(0, 1)}
      </span>
    );
  }
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden>
      <path d={icon.path} fill={`#${icon.hex}`} />
    </svg>
  );
}
