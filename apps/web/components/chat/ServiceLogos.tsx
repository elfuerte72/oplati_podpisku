import type { ReactNode } from 'react';
import type { SimpleIcon } from 'simple-icons';
import {
  siAirbnb,
  siApple,
  siApplemusic,
  siClaude,
  siCrunchyroll,
  siCursor,
  siDiscord,
  siFigma,
  siGithubcopilot,
  siGooglegemini,
  siHbomax,
  siIcloud,
  siMistralai,
  siNetflix,
  siNotion,
  siPlaystation,
  siSpotify,
  siYoutube,
} from 'simple-icons';

/**
 * Логотипы сервисов витрины. Где бренд есть в simple-icons — используем его.
 * Для брендов, отсутствующих в установленном пакете иконок, держим локальный
 * компактный glyph, чтобы карточки не падали на буквенный fallback.
 */
type CustomLogo = {
  kind: 'custom';
  render: (size: number) => ReactNode;
};

type ServiceIcon = SimpleIcon | { path: string; hex: string } | CustomLogo;

function isCustomLogo(icon: ServiceIcon): icon is CustomLogo {
  return 'kind' in icon && icon.kind === 'custom';
}

const chatGptGlyph: CustomLogo = {
  kind: 'custom',
  render: (size) => (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden>
      <g fill="none" stroke="#10A37F" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9.2 3.6c1.8-1 4.1-.4 5.2 1.4l.5.9 1-.1c2-.1 3.8 1.4 4 3.4.1.7 0 1.4-.3 2.1l-.4.9.7.7c1.4 1.5 1.4 3.8 0 5.2-.5.5-1.1.9-1.8 1.1l-1 .3-.3 1c-.7 1.9-2.8 2.9-4.7 2.2-.7-.2-1.2-.6-1.7-1.2l-.7-.8-.9.4c-1.9.8-4.1 0-4.9-1.8-.3-.7-.4-1.4-.3-2.1l.1-1-1-.5C1 14.6.4 12.3 1.4 10.5c.4-.6.9-1.1 1.5-1.5l.9-.5-.1-1c-.1-1.6.8-3.1 2.2-3.8 1.1-.5 2.3-.5 3.3-.1Z" />
        <path d="M8.1 7.2 12 5l3.9 2.2v4.5L12 14 8.1 11.7V7.2Z" />
        <path d="M8.1 11.7v4.5l3.9 2.2 3.9-2.2v-4.5" />
        <path d="m4.2 9.5 3.9 2.2M15.9 11.7l3.9-2.2M12 14v4.4" />
      </g>
    </svg>
  ),
};

const midjourneyGlyph: CustomLogo = {
  kind: 'custom',
  render: (size) => (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden>
      <path
        d="M4.2 18.6h15.6c-.5 1.2-1.6 2-3 2H7.2c-1.4 0-2.5-.8-3-2Zm2.1-2.1 4.5-11.7c.2-.5.8-.6 1.2-.2l6.7 11.9H6.3Zm7.2-8.2-1.7 8.2h6.4l-4.7-8.2Zm-3.3 2.4-2.3 5.8h3.1l-.8-5.8Z"
        fill="#15151A"
      />
    </svg>
  ),
};

const adobeCreativeCloudGlyph: CustomLogo = {
  kind: 'custom',
  render: (size) => (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden>
      <path
        d="M5.2 4h13.6A2.2 2.2 0 0 1 21 6.2v11.6a2.2 2.2 0 0 1-2.2 2.2H5.2A2.2 2.2 0 0 1 3 17.8V6.2A2.2 2.2 0 0 1 5.2 4Zm4.2 11.5c1.6 0 2.7-1 3.5-2.4.7 1.4 1.9 2.4 3.5 2.4 2.1 0 3.5-1.6 3.5-3.7 0-2.4-1.8-4.4-4.1-4.4-1.4 0-2.5.6-3.4 1.7-.8-1.1-2-1.7-3.4-1.7-2.3 0-4.1 2-4.1 4.4 0 2.1 1.5 3.7 3.5 3.7Zm.2-2.4c-1.1 0-1.9-.6-1.9-1.6 0-1.1.9-2.1 2.1-2.1 1 0 1.8.7 2.4 1.9-.7 1.2-1.5 1.8-2.6 1.8Zm6.1 0c-1 0-1.9-.6-2.5-1.8.6-1.2 1.4-1.9 2.4-1.9 1.2 0 2.1 1 2.1 2.1 0 1-.8 1.6-2 1.6Z"
        fill="#DA1F26"
      />
    </svg>
  ),
};

const disneyPlusGlyph: CustomLogo = {
  kind: 'custom',
  render: (size) => (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden>
      <g fill="none" stroke="#113CCF" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3.5 8.5C7 3.9 14.8 2.8 20.6 5.9" strokeWidth="1.7" />
        <path d="M17.2 7.4h4.2M19.3 5.3v4.2" strokeWidth="1.8" />
      </g>
      <path
        d="M4.5 11.2h4.2c2.8 0 4.7 1.7 4.7 4.1s-1.9 4.1-4.7 4.1H4.5v-8.2Zm2.4 2v4.2h1.6c1.4 0 2.4-.8 2.4-2.1s-1-2.1-2.4-2.1H6.9Zm7.5 6.2v-8.2h2.4v6.1h3.7v2.1h-6.1Z"
        fill="#113CCF"
      />
    </svg>
  ),
};

const grokGlyph: CustomLogo = {
  kind: 'custom',
  render: (size) => (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden>
      <path
        d="M4.1 18.5 16.8 5.8c.9-.9 2.2-1.3 3.5-1.1L7.6 17.4c-.9.9-2.2 1.3-3.5 1.1Zm2.6-12.4c3.3-.7 6.5.2 8.8 2.4l-2.2 2.2c-1.7-1.5-3.9-2.1-6.2-1.6l-.4-3Zm10.7 7.2 2.2-2.2c.8 2.1.8 4.6-.1 6.9l-3-.5c.6-1.5.5-3-.1-4.2ZM8.2 20.1l2.3-2.3c1.8.5 3.8.3 5.7-.7l.8 2.8c-2.9 1.4-6.1 1.5-8.8.2Z"
        fill="#15151A"
      />
    </svg>
  ),
};

const xboxGlyph: ServiceIcon = {
  hex: '107C10',
  path: 'M12 2.5c2.1 0 4.05.68 5.63 1.84-2.19.2-4.12 1.21-5.63 2.74-1.51-1.53-3.44-2.54-5.63-2.74A9.43 9.43 0 0 1 12 2.5Zm-7.1 3.2c2.18.1 4.16 1.05 5.68 2.6-1.86 2.31-3.05 5.3-3.38 8.46-1.75-1.73-2.84-4.13-2.84-6.78 0-1.55.37-3.02 1.04-4.28Zm14.2 0c.67 1.26 1.04 2.73 1.04 4.28 0 2.65-1.09 5.05-2.84 6.78-.33-3.16-1.52-6.15-3.38-8.46 1.52-1.55 3.5-2.5 5.68-2.6ZM12 9.77c2.07 2.47 3.27 5.85 3.34 9.34A9.43 9.43 0 0 1 12 19.7a9.43 9.43 0 0 1-3.34-.59c.07-3.49 1.27-6.87 3.34-9.34Z',
};

const LOGOS: Record<string, ServiceIcon> = {
  'chatgpt-plus': chatGptGlyph,
  'claude-pro': siClaude,
  'midjourney-basic': midjourneyGlyph,
  'netflix-premium': siNetflix,
  'spotify-premium': siSpotify,
  airbnb: siAirbnb,
  'youtube-premium': siYoutube,
  'discord-nitro': siDiscord,
  'apple-one': siApple,
  'icloud-plus-200gb': siIcloud,
  'apple-music': siApplemusic,
  'notion-plus': siNotion,
  'figma-professional': siFigma,
  'github-copilot': siGithubcopilot,
  'gemini-advanced': siGooglegemini,
  'grok-pro': grokGlyph,
  'mistral-pro': siMistralai,
  'adobe-creative-cloud': adobeCreativeCloudGlyph,
  'disney-plus': disneyPlusGlyph,
  'hbo-max': siHbomax,
  'crunchyroll-mega-fan': siCrunchyroll,
  'cursor-pro': siCursor,
  'playstation-plus': siPlaystation,
  'xbox-game-pass': xboxGlyph,
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
  const icon = LOGOS[slug];
  if (!icon) {
    return (
      <span aria-hidden className="font-display text-xl font-bold text-[var(--color-ink)]">
        {name.slice(0, 1)}
      </span>
    );
  }
  if (isCustomLogo(icon)) {
    return icon.render(size);
  }
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden>
      <path d={icon.path} fill={`#${icon.hex}`} />
    </svg>
  );
}
