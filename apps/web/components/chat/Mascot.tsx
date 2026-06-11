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

// Версия ассетов: bump при замене PNG — пробивает кэш браузера и next/image
// (URL входит в ключ кэша оптимизатора). Экспорт — для IntroOverlay (рисует
// маскота напрямую через next/image со своей анимацией «нарисовывания»).
export const ASSET_VERSION = '2';

export function mascotSrc(pose: MascotPose): string {
  return `/mascot/${pose}.png?v=${ASSET_VERSION}`;
}

/**
 * Маскот-ведущий. Статичный (фидбек владельца 2026-06-11: без idle-качания
 * и без кликабельной пасхалки) — живость только в смене позы по состоянию
 * диалога: attentive (пользователь печатает) / thinking (агент отвечает) /
 * presenting / celebrate. Смена позы «попает» (comic-pop, разово 220мс).
 * Ассеты — PNG с прозрачным фоном («стикер»), объём — drop-shadow по силуэту.
 */
export function Mascot({ pose, size = 48 }: { pose: MascotPose; size?: number }) {
  return (
    <span className="inline-block shrink-0" style={{ width: size, height: size }}>
      <Image
        key={pose}
        src={mascotSrc(pose)}
        alt={LABELS[pose]}
        width={size}
        height={size}
        priority
        className="h-full w-full object-contain [filter:drop-shadow(3px_3px_0_rgba(11,10,13,0.45))] motion-safe:animate-[comic-pop_220ms_var(--ease-pop)_both]"
      />
    </span>
  );
}
