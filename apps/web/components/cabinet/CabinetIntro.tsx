'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { ComicButton } from '@/components/comic/ComicButton';
import { PaidStamp } from '@/components/comic/PaidStamp';
import { IconArrowLeft, IconArrowRight, IconCheck } from '@/components/comic/icons';
import { Mascot, type MascotPose } from '@/components/chat/Mascot';
import { track } from '@/lib/analytics/client';

/**
 * Онбординг Telegram Mini App (трек miniapp-tabs, тикет 11).
 *
 * Три кадра вместо четырёх, и главная мысль — первой: раньше «сам
 * оплачиваешь на сайте сервиса» стояло последним, а «Пропустить» доступен с
 * первого кадра (находка П17) — пропустившие так и не узнавали, что подписку
 * оформляют сами. Второй кадр показывает, где что лежит после переделки на
 * вкладки: карта — во вкладке «Карта», туда же приложение переведёт после
 * оплаты.
 *
 * Макеты экранов — CSS, а не скриншоты: не устаревают. Показ — один раз
 * (флаг в CabinetClient), повтор — из «Профиль → Как это работает» и из
 * полоски трёх шагов на «Оплате».
 */

type IntroHaptic = (kind: 'tick' | 'success') => void;

type Frame = { title: string; text: string; pose: MascotPose; visual: () => ReactNode };

const FRAMES: readonly Frame[] = [
  {
    title: 'Три шага к подписке',
    text: 'Платишь нам рублями — получаешь виртуальную карту в долларах — и этой картой сам оплачиваешь подписку на сайте сервиса.',
    pose: 'wave',
    visual: () => <SchemeMock />,
  },
  {
    title: 'Карта — во вкладке «Карта»',
    text: 'Там номер, срок, CVC и адрес плательщика — всё, что спросит сайт сервиса. После оплаты приложение само переведёт тебя туда.',
    pose: 'presenting',
    visual: () => <CardTabMock />,
  },
  {
    title: 'Оплачиваешь на сайте сервиса',
    text: 'Включи VPN, если сервис его просит, проверь, что цена в долларах, и плати в браузере, а не в приложении. Аккаунт остаётся твоим — пароль передавать не нужно.',
    pose: 'celebrate',
    visual: () => <PayOnSiteMock />,
  },
];

const LAST = FRAMES.length - 1;

/** Порог свайпа в px, за которым засчитываем листание кадра. */
const SWIPE_THRESHOLD = 44;

export function CabinetIntro({
  onClose,
  haptic,
}: {
  onClose: () => void;
  haptic?: IntroHaptic;
}) {
  const [frame, setFrame] = useState(0);
  const touchStartX = useRef<number | null>(null);

  const go = useCallback(
    (next: number) => {
      const clamped = Math.max(0, Math.min(LAST, next));
      setFrame((prev) => {
        if (clamped !== prev) haptic?.('tick');
        return clamped;
      });
    },
    [haptic],
  );

  /** Закрыт до конца — «Пропустить», Escape. Кадр с нуля. */
  const skip = useCallback(() => {
    track('intro_skip', { frame });
    onClose();
  }, [frame, onClose]);

  const finish = useCallback(() => {
    track('intro_complete');
    haptic?.('success');
    onClose();
  }, [haptic, onClose]);

  const advance = useCallback(() => {
    if (frame >= LAST) finish();
    else go(frame + 1);
  }, [frame, finish, go]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') skip();
      else if (e.key === 'ArrowRight') advance();
      else if (e.key === 'ArrowLeft') go(frame - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [skip, advance, go, frame]);

  const current = FRAMES[frame] ?? FRAMES[0]!;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Как работает Оплатишка"
      className="halftone fixed inset-0 z-[70] flex flex-col overflow-y-auto bg-[var(--bg)]"
      onTouchStart={(e) => {
        touchStartX.current = e.touches[0]?.clientX ?? null;
      }}
      onTouchEnd={(e) => {
        const start = touchStartX.current;
        touchStartX.current = null;
        if (start === null) return;
        const dx = (e.changedTouches[0]?.clientX ?? start) - start;
        if (dx <= -SWIPE_THRESHOLD) advance();
        else if (dx >= SWIPE_THRESHOLD) go(frame - 1);
      }}
    >
      <div className="mx-auto flex min-h-full w-full max-w-md flex-col px-5 pt-4 pb-6">
        {/* Верх: точки прогресса + «Пропустить» */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5" role="tablist" aria-label="Шаги">
            {FRAMES.map((f, i) => (
              <button
                key={f.title}
                type="button"
                role="tab"
                aria-selected={i === frame}
                aria-label={`Шаг ${i + 1}`}
                onClick={() => go(i)}
                className={[
                  'h-2 rounded-full border-2 border-[var(--shadow-ink)] transition-[width,background-color] duration-200',
                  i === frame ? 'w-6 bg-[var(--accent)]' : 'w-2 bg-[var(--surface-2)]',
                ].join(' ')}
              />
            ))}
          </div>
          <button
            type="button"
            onClick={skip}
            className="min-h-10 font-body text-sm text-[var(--text-muted)] underline-offset-2 active:opacity-70"
          >
            Пропустить
          </button>
        </div>

        <div
          key={`copy-${frame}`}
          className="mt-6 flex items-center gap-3 motion-safe:animate-[intro-rise_360ms_var(--ease-pop)_both]"
        >
          <Mascot pose={current.pose} size={88} />
          <div className="min-w-0">
            <span className="inline-block rounded-full border-2 border-[var(--shadow-ink)] bg-[var(--color-teal-primary)] px-2.5 py-0.5 font-display text-xs font-bold text-[var(--color-paper)]">
              {frame + 1} из {FRAMES.length}
            </span>
            <h2 className="mt-1.5 font-display text-[22px] leading-tight font-bold text-[var(--text)]">
              {current.title}
            </h2>
          </div>
        </div>

        <p
          key={`text-${frame}`}
          className="mt-3 font-body text-[16px] leading-relaxed text-[var(--text)] motion-safe:animate-[intro-rise_360ms_var(--ease-pop)_40ms_both]"
        >
          {current.text}
        </p>

        <div
          key={`visual-${frame}`}
          className="flex flex-1 flex-col items-center justify-center py-5 motion-safe:animate-[intro-rise_360ms_var(--ease-pop)_80ms_both]"
        >
          <div className="w-full max-w-[300px]">{current.visual()}</div>
          <p className="mt-3 font-body text-xs text-[var(--text-muted)]">Пример для наглядности</p>
        </div>

        {/* Навигация — закреплена внизу (удобно большому пальцу). */}
        <div className="mt-2 flex items-center gap-3">
          {frame > 0 && (
            <button
              type="button"
              onClick={() => go(frame - 1)}
              aria-label="Назад"
              className="inline-flex min-h-11 items-center gap-1 font-display text-sm font-bold text-[var(--link)] active:opacity-70"
            >
              <IconArrowLeft size={16} />
              Назад
            </button>
          )}
          <ComicButton onClick={advance} className="ml-auto inline-flex items-center gap-1.5">
            {frame >= LAST ? (
              <>
                <IconCheck size={18} />
                Понятно, начать!
              </>
            ) : (
              <>
                Дальше
                <IconArrowRight size={18} />
              </>
            )}
          </ComicButton>
        </div>
      </div>
    </div>
  );
}

const mockBox =
  'rounded-[var(--radius-card)] border-[2.5px] border-[var(--shadow-ink)] bg-[var(--surface)] shadow-[var(--shadow-comic)]';

/** Кадр 1: схема трёх шагов — рубли → карта в долларах → сайт сервиса. */
function SchemeMock() {
  const rows = [
    { n: 1, label: 'Платишь рублями', chip: '2 460 ₽' },
    { n: 2, label: 'Получаешь карту', chip: '$20' },
    { n: 3, label: 'Сам платишь на сайте', chip: 'chatgpt.com' },
  ];
  return (
    <div className={`${mockBox} flex flex-col gap-2.5 p-3.5`}>
      {rows.map((row) => (
        <div key={row.n} className="flex items-center gap-2.5">
          <span className="flex size-[26px] shrink-0 items-center justify-center rounded-full border-2 border-[var(--color-teal-light)] bg-[var(--color-teal-deep)] font-body text-[13px] font-bold text-[var(--color-paper)]">
            {row.n}
          </span>
          <span className="min-w-0 flex-1 font-body text-sm font-semibold text-[var(--text)]">{row.label}</span>
          <span className="shrink-0 rounded-full border-2 border-[var(--shadow-ink)] bg-[var(--surface-2)] px-2.5 py-0.5 font-display text-xs font-bold text-[var(--text)]">
            {row.chip}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Кадр 2: карта во вкладке «Карта» — вид карты и нижняя панель с подсветкой. */
function CardTabMock() {
  return (
    <div className="flex w-full flex-col gap-3">
      <div
        className="halftone relative flex aspect-[1.6/1] w-full flex-col justify-between overflow-hidden rounded-[var(--radius-card)] border-[2.5px] border-[var(--shadow-ink)] p-4 text-[var(--color-paper)] shadow-[var(--shadow-comic-lg)]"
        style={{ background: 'linear-gradient(135deg, var(--color-teal-deep), var(--color-teal-primary))' }}
      >
        <div className="flex items-start justify-between">
          <span className="font-display text-base font-bold tracking-tight">Оплатишка</span>
          <span className="inline-flex items-center gap-1.5 rounded-full border-2 border-[var(--shadow-ink)] bg-[var(--color-paper)] px-2 py-0.5 font-display text-[10px] font-bold text-[var(--color-ink)]">
            <span className="size-2 rounded-full" style={{ background: 'var(--success)' }} />
            Активна
          </span>
        </div>
        <span className="h-6 w-9 rounded-[6px] border-2 border-[var(--shadow-ink)] bg-[var(--color-skin)]" />
        <p className="font-display text-lg font-bold tracking-[0.14em]">•••• •••• •••• 4242</p>
        <div className="flex items-end justify-between">
          <span className="font-body text-[10px] tracking-wider uppercase opacity-80">Виртуальная карта</span>
          <span className="font-display text-base font-bold">$20</span>
        </div>
      </div>
      <div className={`${mockBox} flex justify-around px-2 py-1.5`}>
        {['Оплата', 'Карта', 'Профиль'].map((label) => (
          <span
            key={label}
            className={[
              'rounded-full px-3 py-1 font-body text-xs',
              label === 'Карта'
                ? 'bg-[color-mix(in_srgb,var(--color-teal-primary)_24%,transparent)] font-semibold text-[var(--accent)]'
                : 'text-[var(--text-muted)]',
            ].join(' ')}
          >
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Кадр 3: «оплата на сайте сервиса» — форма с картой + штамп «ОПЛАЧЕНО». */
function PayOnSiteMock() {
  return (
    <div className="relative w-full">
      <div className={mockBox}>
        <div className="flex items-center gap-1.5 rounded-t-[var(--radius-card)] border-b-2 border-[var(--shadow-ink)] bg-[var(--surface-2)] px-3 py-2">
          <span className="size-2.5 rounded-full border border-[var(--shadow-ink)] bg-[var(--color-stamp)]" />
          <span className="size-2.5 rounded-full border border-[var(--shadow-ink)] bg-[var(--color-skin)]" />
          <span className="size-2.5 rounded-full border border-[var(--shadow-ink)] bg-[var(--success)]" />
          <span className="ml-2 font-body text-[11px] text-[var(--text-muted)]">сайт сервиса</span>
        </div>
        <div className="space-y-2.5 p-4">
          <p className="font-display text-sm font-bold text-[var(--text)]">Оплата подписки · $20</p>
          <div className="rounded-[12px] border-2 border-[var(--shadow-ink)] bg-[var(--bg)] px-3 py-2 font-display text-sm font-bold tracking-[0.1em] text-[var(--text)]">
            4242 4242 4242 4242
          </div>
          <div className="flex gap-2.5">
            <div className="flex-1 rounded-[12px] border-2 border-[var(--shadow-ink)] bg-[var(--bg)] px-3 py-2 font-display text-sm font-bold text-[var(--text)]">
              08 / 29
            </div>
            <div className="flex-1 rounded-[12px] border-2 border-[var(--shadow-ink)] bg-[var(--bg)] px-3 py-2 font-display text-sm font-bold text-[var(--text)]">
              •••
            </div>
          </div>
        </div>
      </div>
      <div className="pointer-events-none absolute right-2 -bottom-3">
        <PaidStamp />
      </div>
    </div>
  );
}
