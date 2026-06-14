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
  siHbomax,
  siIcloud,
  siNetflix,
  siNotion,
  siSpotify,
  siYoutube,
} from 'simple-icons';

/**
 * Логотипы сервисов витрины. simple-icons по slug каталога; брендов, выпиленных
 * из simple-icons по trademark-запросам (OpenAI, Midjourney, LinkedIn, Adobe,
 * Disney+), там нет — для них fallback: первая буква в font-display (тот же
 * паттерн, что плашка в CatalogCard).
 */
const LOGOS: Record<string, SimpleIcon> = {
  'claude-pro': siClaude,
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
  'hbo-max': siHbomax,
  'crunchyroll-mega-fan': siCrunchyroll,
  'cursor-pro': siCursor,
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
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden>
      <path d={icon.path} fill={`#${icon.hex}`} />
    </svg>
  );
}
