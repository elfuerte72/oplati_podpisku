'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { ComicButton } from '@/components/comic/ComicButton';
import { IconArrowLeft, IconArrowRight, IconCheck } from '@/components/comic/icons';
import { Mascot, type MascotPose } from './Mascot';

/**
 * Онбординг сайта «Как это работает» — три коротких шага с индикатором
 * прогресса «N из 3» (ТЗ «клиентский путь» §2). Открывается кнопкой на первом
 * экране чата; тексты — финальные из ТЗ. Страна выпуска карты публично не
 * указывается; терминология — «виртуальная карта».
 */

type Step = { title: string; lines: readonly string[]; pose: MascotPose };

const STEPS = [
  {
    title: 'Выбираешь сервис и платишь рублями',
    lines: [
      'Выбери нужный сервис и тариф. Оплатить заказ можно российской картой или через СБП.',
      'Перед оплатой ты увидишь полную итоговую сумму.',
    ],
    pose: 'presenting',
  },
  {
    title: 'Получаешь виртуальную карту',
    lines: [
      'После оплаты мы выпустим виртуальную карту и пополним её на сумму подписки.',
      'Номер карты, срок, CVC и данные для оплаты появятся в личном кабинете и придут в Telegram.',
      'Стоимость выпуска первой карты — $4. При повторных пополнениях этой же карты выпуск повторно не оплачивается. Карта действует 180 дней.',
    ],
    pose: 'attentive',
  },
  {
    title: 'Оплачиваешь подписку на своём аккаунте',
    lines: [
      'Открой сайт сервиса, войди в свой аккаунт и введи реквизиты полученной карты.',
      'Пароль передавать нам не нужно — история и настройки аккаунта остаются у тебя.',
      'Если сервису нужен VPN — обязательную локацию и валюту покажем в карточке сервиса и в инструкции к карте.',
    ],
    pose: 'celebrate',
  },
] as const satisfies readonly Step[];

const LAST = STEPS.length - 1;

export function HowItWorksOverlay({ onClose }: { onClose: () => void }) {
  const [frame, setFrame] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Доступность: при открытии фокус уходит внутрь диалога (иначе клавиатурный
  // пользователь остаётся «за» оверлеем), при закрытии возвращается на кнопку,
  // которая его открыла.
  useEffect(() => {
    const opener = document.activeElement;
    dialogRef.current?.focus();
    return () => {
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, []);

  const go = useCallback((next: number) => {
    setFrame(Math.max(0, Math.min(LAST, next)));
  }, []);

  const advance = useCallback(() => {
    if (frame >= LAST) onClose();
    else go(frame + 1);
  }, [frame, go, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight') advance();
      else if (e.key === 'ArrowLeft') go(frame - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, advance, go, frame]);

  // Всегда валидный шаг: frame клампится в go().
  const step = STEPS[frame] ?? STEPS[0];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Как это работает"
      className="fixed inset-0 z-[65] flex items-center justify-center bg-[rgba(11,10,13,0.55)] p-4"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="presentation"
        tabIndex={-1}
        className="halftone w-full max-w-lg rounded-[var(--radius-card)] border-[2.5px] border-[var(--shadow-ink)] bg-[var(--bg)] p-6 shadow-[var(--shadow-comic-lg)] focus:outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Верх: прогресс «N из 3» + «Пропустить» */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className="font-display text-sm font-bold text-[var(--text-muted)]">
              {frame + 1} из {STEPS.length}
            </span>
            <div className="flex items-center gap-1.5" aria-hidden>
              {STEPS.map((s, i) => (
                <span
                  key={s.title}
                  className={[
                    'h-2 rounded-full border-2 border-[var(--shadow-ink)] transition-[width,background-color] duration-200',
                    i === frame ? 'w-6 bg-[var(--accent)]' : 'w-2 bg-[var(--surface-2)]',
                  ].join(' ')}
                />
              ))}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="font-body text-sm text-[var(--text-muted)] underline-offset-2 hover:underline"
          >
            Пропустить
          </button>
        </div>

        {/* Шаг */}
        <div key={frame} className="mt-5 motion-safe:animate-[intro-rise_360ms_var(--ease-pop)_both]">
          <div className="flex items-center gap-4">
            <Mascot pose={step.pose} size={84} />
            <div className="min-w-0">
              <span className="inline-block rounded-full border-2 border-[var(--shadow-ink)] bg-[var(--color-teal-primary)] px-2.5 py-0.5 font-display text-xs font-bold text-[var(--color-paper)]">
                Шаг {frame + 1}
              </span>
              <h2 className="mt-1.5 font-display text-xl font-bold leading-tight text-[var(--text)]">
                {step.title}
              </h2>
            </div>
          </div>
          <div className="mt-3 space-y-2">
            {step.lines.map((line) => (
              <p key={line} className="font-body text-[15px] leading-relaxed text-[var(--text)]">
                {line}
              </p>
            ))}
          </div>
        </div>

        {/* Навигация */}
        <div className="mt-6 flex items-center gap-3">
          {frame > 0 && (
            <button
              type="button"
              onClick={() => go(frame - 1)}
              className="inline-flex items-center gap-1 font-display text-sm font-bold text-[var(--link)]"
            >
              <IconArrowLeft size={16} />
              Назад
            </button>
          )}
          <ComicButton onClick={advance} className="ml-auto inline-flex items-center gap-1.5">
            {frame >= LAST ? (
              <>
                <IconCheck size={18} />
                Понятно!
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
