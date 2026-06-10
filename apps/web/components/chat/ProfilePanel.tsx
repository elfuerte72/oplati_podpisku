import { Mascot, type MascotPose } from './Mascot';

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="font-body text-sm text-[var(--text-muted)]">{label}</span>
      <span className="font-body text-sm font-semibold text-[var(--text)]">{value}</span>
    </div>
  );
}

/**
 * Правая панель: крупный Оплатишка — единственный маскот на десктопе.
 * Свободно стоит на фоне панели (ассет с прозрачным фоном, без рамок),
 * анимируется по состоянию диалога: думает / показывает / радуется.
 * Ниже — mock личного профиля (реальный кабинет позже).
 */
export function ProfilePanel({
  pose,
  onPoke,
  quip,
  typing = false,
}: {
  pose: MascotPose;
  onPoke?: () => void;
  quip?: string | null;
  typing?: boolean;
}) {
  return (
    <aside className="hidden w-80 shrink-0 flex-col gap-4 overflow-y-auto border-l-[2.5px] border-[var(--shadow-ink)] bg-[var(--surface)] p-4 lg:flex">
      {/* Маскот — свободно, без плашки */}
      <div className="relative flex flex-col items-center gap-1 pt-3">
        {quip && (
          <span className="absolute -top-1 z-10 whitespace-nowrap rounded-[14px] rounded-bl-[4px] border-2 border-[var(--shadow-ink)] bg-[var(--bubble-bot)] px-3 py-1.5 font-body text-sm text-[var(--text)] shadow-[var(--shadow-comic)] motion-safe:animate-[comic-pop_180ms_var(--ease-pop)_both]">
            {quip}
          </span>
        )}
        <Mascot pose={pose} size={160} onPoke={onPoke} />
        <span className="font-display text-lg font-bold text-[var(--text)]">Оплатишка</span>
        <span className="font-body text-xs text-[var(--text-muted)]" role="status">
          {typing ? 'печатает…' : 'твой помощник по оплате'}
        </span>
      </div>

      {/* Mock личного профиля */}
      <div className="space-y-3 rounded-[var(--radius-card)] border-[2.5px] border-[var(--shadow-ink)] bg-[var(--surface-2)] p-4 shadow-[var(--shadow-comic)]">
        <h3 className="font-display font-bold text-[var(--text)]">Личный профиль</h3>
        <div className="flex items-center gap-3">
          <span className="grid h-11 w-11 place-items-center rounded-full border-2 border-[var(--shadow-ink)] bg-[var(--bg)] font-display text-lg font-bold text-[var(--text)]">
            Г
          </span>
          <div className="leading-tight">
            <span className="block font-display font-bold text-[var(--text)]">Гость</span>
            <span className="font-body text-xs text-[var(--text-muted)]">без регистрации</span>
          </div>
        </div>
        <div className="space-y-1.5 border-t-2 border-[var(--shadow-ink)] pt-3">
          <Row label="Заказов" value="0" />
          <Row label="Потрачено" value="0 ₽" />
          <Row label="Telegram" value="не привязан" />
        </div>
        <button
          type="button"
          disabled
          className="w-full cursor-not-allowed rounded-[var(--radius-card)] border-[2.5px] border-[var(--shadow-ink)] bg-[var(--bg)] px-4 py-2 font-display font-bold text-[var(--text-muted)] opacity-80"
        >
          Привязать Telegram
        </button>
        <p className="font-body text-xs text-[var(--text-muted)]">
          Mock-данные — личный кабинет появится позже.
        </p>
      </div>
    </aside>
  );
}
