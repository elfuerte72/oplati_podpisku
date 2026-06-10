import Image from 'next/image';

export type MascotPose = 'idle' | 'thinking' | 'presenting' | 'celebrate' | 'wave';

const LABELS: Record<MascotPose, string> = {
  idle: 'Оплатишка',
  thinking: 'Оплатишка думает',
  presenting: 'Оплатишка показывает варианты',
  celebrate: 'Оплатишка радуется',
  wave: 'Оплатишка машет',
};

// Микро-анимация по состоянию: дышит в покое, качается когда думает,
// подпрыгивает на празднике. Всё гасится prefers-reduced-motion.
// Версия ассетов: bump при замене PNG — пробивает кэш браузера и next/image
// (URL входит в ключ кэша оптимизатора).
const ASSET_VERSION = '2';

const POSE_ANIM: Record<MascotPose, string> = {
  idle: 'motion-safe:animate-[mascot-bob_3.4s_ease-in-out_infinite]',
  wave: 'motion-safe:animate-[mascot-bob_2.2s_ease-in-out_infinite]',
  thinking: 'motion-safe:animate-[mascot-think_1.4s_ease-in-out_infinite]',
  presenting: 'motion-safe:animate-[mascot-bob_2.2s_ease-in-out_infinite]',
  celebrate: 'motion-safe:animate-[mascot-cheer_0.8s_ease-in-out_infinite]',
};

/**
 * Живой маскот-ведущий. Поза отражает состояние диалога (state-машина в
 * ChatClient). Ассеты — PNG с прозрачным фоном (вырезанный «стикер»), поэтому
 * без рамок и плашек — только drop-shadow по силуэту. Смена позы «попает»
 * (comic-pop). С `onPoke` — кликабелен (пасхалка).
 */
export function Mascot({
  pose,
  size = 48,
  onPoke,
}: {
  pose: MascotPose;
  size?: number;
  onPoke?: () => void;
}) {
  const img = (
    <Image
      key={pose}
      src={`/mascot/${pose}.png?v=${ASSET_VERSION}`}
      alt={LABELS[pose]}
      width={size}
      height={size}
      priority
      className="h-full w-full object-contain [filter:drop-shadow(3px_3px_0_rgba(11,10,13,0.45))] motion-safe:animate-[comic-pop_220ms_var(--ease-pop)_both]"
    />
  );

  if (onPoke) {
    return (
      <button
        type="button"
        onClick={onPoke}
        aria-label="Потыкать Оплатишку"
        title="Потыкай меня!"
        className={`inline-block shrink-0 cursor-pointer transition-transform active:scale-95 ${POSE_ANIM[pose]}`}
        style={{ width: size, height: size }}
      >
        {img}
      </button>
    );
  }

  return (
    <span className={`inline-block shrink-0 ${POSE_ANIM[pose]}`} style={{ width: size, height: size }}>
      {img}
    </span>
  );
}
