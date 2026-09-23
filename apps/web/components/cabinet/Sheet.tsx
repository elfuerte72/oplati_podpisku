'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { createSheetStack } from '@/lib/cabinet/sheet-stack';

import { currentTelegramWebApp, tolerateTelegram } from './telegram';

/**
 * Нижний лист Mini App (трек miniapp-tabs, тикет 03) — по образцу
 * `nemo_project/apps/miniapp/app/ui/sheet.tsx`.
 *
 * Всё второстепенное — заказ, реквизиты, партнёрка, правка контактов —
 * открывается листом поверх вкладки, а не отдельной страницей: приложение живёт
 * внутри Telegram, и своя навигация в нём спорит с системной «Назад».
 *
 * Разметка уходит в конец `body`: ряд вкладок едет `transform`'ом, а такой
 * предок становится системой отсчёта для `position: fixed` — лист внутри него
 * перестал бы закрывать нижнюю панель.
 *
 * Закрывается тремя способами — крестиком, тапом мимо и потягом вниз за
 * полоску, — плюс системной «Назад» Telegram, пока лист открыт.
 */

/** Сколько надо утянуть лист вниз, чтобы отпускание его закрыло. */
const DRAG_CLOSE_PX = 96;
/** Скорость броска (px/мс), которой хватает, чтобы закрыть не дотянув. */
const FLICK_PX_PER_MS = 0.5;
/** Сколько лист уезжает вниз, прежде чем его снимут. */
const DRAG_SETTLE_MS = 180;

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** Один счёт открытых листов на приложение: «Назад» закрывает верхний. */
const sheetStack = createSheetStack();

function IconClose() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export function Sheet({
  title,
  subtitle,
  ariaLabel,
  onClose,
  children,
  bare = false,
  flushBottom = false,
}: {
  /** Заголовок листа. Без него — `ariaLabel` (партнёрский кабинет со своей шапкой). */
  title?: string | undefined;
  subtitle?: string | undefined;
  ariaLabel?: string | undefined;
  onClose: () => void;
  children: ReactNode;
  /** Содержимое со своей вёрсткой во всю ширину: без отступов листа. */
  bare?: boolean;
  /**
   * Без нижнего отступа: содержимое держит закреплённый низ (`sticky bottom-0`,
   * кнопка «Оплатить») и safe-area отдаёт ему само — иначе под кнопкой
   * оставалась бы полоса прокручиваемого содержимого.
   */
  flushBottom?: boolean;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const gripRef = useRef<HTMLDivElement>(null);
  /*
   * Закрытие — за ссылкой, а не в зависимостях. Обработчик приходит новой
   * функцией на каждом рендере открывшего, и честная зависимость снимала бы и
   * ставила заново «Назад» и слушатели клавиш на каждый его рендер — вместе с
   * возвратом фокуса «тому, кто открыл».
   */
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  useEffect(() => {
    const panel = panelRef.current;
    const opener = document.activeElement;
    panel?.focus({ preventScroll: true });

    const depth = sheetStack.push();

    const onKeyDown = (event: KeyboardEvent) => {
      if (!sheetStack.isTop(depth)) return;
      if (event.key === 'Escape') {
        closeRef.current();
        return;
      }
      // Обход клавишей Tab не уходит из листа: он объявлен модальным.
      if (event.key !== 'Tab' || !panel) return;
      const stops = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => !el.hasAttribute('disabled') && el.offsetParent !== null,
      );
      const first = stops[0];
      const last = stops.at(-1);
      if (!first || !last) return;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);

    // Системная «Назад» Telegram закрывает лист, а не приложение. Обработчик
    // у каждого листа свой, прячет кнопку последний уходящий.
    const back = currentTelegramWebApp()?.BackButton;
    const goBack = () => {
      if (sheetStack.isTop(depth)) closeRef.current();
    };
    tolerateTelegram(() => {
      back?.onClick?.(goBack);
      back?.show?.();
    });

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      sheetStack.pop();
      tolerateTelegram(() => {
        back?.offClick?.(goBack);
        if (!sheetStack.backButtonVisible()) back?.hide?.();
      });
      if (opener instanceof HTMLElement) opener.focus({ preventScroll: true });
    };
  }, []);

  /*
   * Потяг вниз за полоску. Указателем, а не касанием: тот же код ведёт и палец,
   * и мышь в Telegram Desktop. Ручка — только полоса сверху: внутри листа
   * прокручиваемое содержимое, и жест, начатый на нём, принадлежит ему.
   */
  useEffect(() => {
    const grip = gripRef.current;
    const panel = panelRef.current;
    if (!grip || !panel) return;

    let startY = 0;
    let startedAt = 0;
    let offset = 0;
    let dragging = false;
    let frame = 0;
    let settling: ReturnType<typeof setTimeout> | undefined;

    const paint = () => {
      frame = 0;
      panel.style.transform = `translate3d(0, ${offset}px, 0)`;
    };
    const down = (event: PointerEvent) => {
      if (event.button !== 0) return;
      dragging = true;
      startY = event.clientY;
      startedAt = event.timeStamp;
      offset = 0;
      grip.setPointerCapture(event.pointerId);
      // Конечный кадр анимации появления сильнее значения в узле — снимаем её.
      panel.style.animation = 'none';
      panel.style.transition = 'none';
    };
    const move = (event: PointerEvent) => {
      if (!dragging) return;
      offset = Math.max(0, event.clientY - startY);
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const up = (event: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      grip.releasePointerCapture(event.pointerId);
      panel.style.transition = '';
      const speed = offset / Math.max(1, event.timeStamp - startedAt);
      if (offset > DRAG_CLOSE_PX || (offset > 20 && speed > FLICK_PX_PER_MS)) {
        panel.style.transform = `translate3d(0, ${panel.offsetHeight}px, 0)`;
        settling = setTimeout(() => closeRef.current(), DRAG_SETTLE_MS);
        return;
      }
      panel.style.transform = '';
    };
    // Жест отняла система (звонок, жест от края) — лист возвращается, а не
    // закрывается: клиент для закрытия ничего не сделал.
    const cancel = () => {
      if (!dragging) return;
      dragging = false;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      panel.style.transition = '';
      panel.style.transform = '';
    };

    grip.addEventListener('pointerdown', down);
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', cancel);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      clearTimeout(settling);
      grip.removeEventListener('pointerdown', down);
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', cancel);
    };
  }, []);

  const markup = (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-[rgba(5,4,7,0.62)] motion-safe:animate-[sheet-fade_200ms_ease-out_both]"
      onClick={(event) => {
        // Тап мимо панели — по самой подложке, а не всплывший из панели.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        {...(title ? { 'aria-labelledby': titleId } : { 'aria-label': ariaLabel ?? 'Окно' })}
        tabIndex={-1}
        className={[
          'relative flex max-h-[calc(100dvh-44px)] w-full max-w-md flex-col outline-none',
          'rounded-t-[24px] border-t-[2.5px] border-[var(--shadow-ink)] bg-[var(--surface)]',
          'shadow-[0_-4px_0_var(--shadow-ink)] sm:border-x-[2.5px]',
          'transition-transform duration-200 ease-out motion-safe:animate-[sheet-in_260ms_cubic-bezier(0.2,0.9,0.25,1)_both]',
        ].join(' ')}
      >
        <div ref={gripRef} className="shrink-0 cursor-grab touch-none pt-2 pb-1.5 active:cursor-grabbing">
          <span aria-hidden className="mx-auto block h-[5px] w-11 rounded-full bg-[color-mix(in_srgb,var(--text-muted)_45%,transparent)]" />
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Закрыть"
          className="absolute top-3 right-3 z-10 flex size-11 items-center justify-center rounded-full text-[var(--text-muted)] active:bg-[var(--surface-2)]"
        >
          <IconClose />
        </button>
        {title && (
          <header className="shrink-0 px-4 pt-1.5 pr-14 pb-3">
            <h2 id={titleId} className="font-display text-2xl leading-tight font-bold text-[var(--text)]">
              {title}
            </h2>
            {subtitle && (
              <p className="mt-0.5 font-body text-sm text-[var(--text-muted)]">{subtitle}</p>
            )}
          </header>
        )}
        <div
          className={[
            'min-h-0 flex-1 overflow-y-auto overscroll-contain',
            bare ? '' : 'px-4',
            bare || flushBottom ? '' : 'pb-[max(20px,env(safe-area-inset-bottom))]',
          ].join(' ')}
        >
          {children}
        </div>
      </div>
    </div>
  );

  // Лист открывается только по действию клиента, то есть уже в браузере.
  return typeof document === 'undefined' ? null : createPortal(markup, document.body);
}
