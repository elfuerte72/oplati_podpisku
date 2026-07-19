import Image from 'next/image';

export type MascotPose =
  | 'idle'
  | 'attentive'
  | 'thinking'
  | 'presenting'
  | 'celebrate'
  | 'wave';

const LABELS: Record<MascotPose, string> = {
  idle: 'Оплатишка',
  attentive: 'Оплатишка внимательно читает',
  thinking: 'Оплатишка думает',
  presenting: 'Оплатишка показывает варианты',
  celebrate: 'Оплатишка радуется',
  wave: 'Оплатишка машет',
};

/**
 * Версия ассетов: bump при замене картинок — пробивает кэш браузера и
 * next/image (URL входит в ключ кэша оптимизатора). Экспорт — для IntroOverlay
 * (рисует маскота напрямую через next/image со своей анимацией «нарисовывания»).
 * v3 — PNG (290–430 KB) конвертированы в WebP (36–72 KB): M-11 аудита, LCP.
 */
export const ASSET_VERSION = '3';

/** URL позы маскота (WebP + версия ассетов для сброса кэша). */
export function mascotSrc(pose: MascotPose): string {
  return `/mascot/${pose}.webp?v=${ASSET_VERSION}`;
}

const POSES: MascotPose[] = ['idle', 'attentive', 'thinking', 'presenting', 'celebrate', 'wave'];

/**
 * Маскот-ведущий. Статичный (фидбек владельца 2026-06-11: без idle-качания
 * и без кликабельной пасхалки) — живость только в смене позы по состоянию
 * диалога: attentive (пользователь печатает) / thinking (агент отвечает) /
 * presenting / celebrate.
 *
 * Все позы монтируются один раз стопкой (absolute) и переключаются чистым
 * CSS-кроссфейдом — раньше <img> пересоздавался по key={pose} и картинка
 * догружалась заново, из-за чего маскот на миг исчезал. Теперь после первого
 * рендера смена позы мгновенна и плавна (opacity + лёгкий scale, ease-pop).
 * Ассеты — WebP с прозрачным фоном («стикер»), объём — drop-shadow по силуэту.
 */
export function Mascot({ pose, size = 48 }: { pose: MascotPose; size?: number }) {
  return (
    <span
      role="img"
      aria-label={LABELS[pose]}
      className="relative inline-block shrink-0"
      style={{ width: size, height: size }}
    >
      {POSES.map((p) => (
        <Image
          key={p}
          src={mascotSrc(p)}
          alt=""
          aria-hidden
          width={size}
          height={size}
          priority={p === 'idle'}
          className={[
            'absolute inset-0 h-full w-full object-contain',
            '[filter:drop-shadow(3px_3px_0_rgba(11,10,13,0.45))]',
            'transition-[opacity,transform] duration-200 [transition-timing-function:var(--ease-pop)]',
            p === pose ? 'scale-100 opacity-100' : 'scale-90 opacity-0',
          ].join(' ')}
        />
      ))}
    </span>
  );
}
