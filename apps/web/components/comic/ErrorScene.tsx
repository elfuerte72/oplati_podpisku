import Image from 'next/image';
import type { ReactNode } from 'react';

/**
 * Комикс-сцена ошибки (404 / рантайм-сбой): Оплатишка в позе `attentive`
 * (взгляд опущен) стоит НАД гигантским кодом ошибки и «смотрит» прямо на
 * него — маскот реагирует на происходящее, как и в чате. Общая для
 * `app/not-found.tsx` (RSC) и `app/error.tsx` (client) — сам компонент без
 * клиентских хуков, поэтому работает в обоих мирах.
 *
 * Один видимый маскот на экране (hard rule №9) — на страницах ошибок другого
 * и нет. Анимация появления — только motion-safe (hard rule №5).
 */
export function ErrorScene({
  code,
  title,
  text,
  children,
}: {
  /** Крупный «код» сцены: «404», «Упс!» и т.п. */
  code: string;
  title: string;
  text: string;
  /** Кнопки действий (ссылки/кнопки уже в комикс-стиле). */
  children?: ReactNode;
}) {
  return (
    <main className="halftone flex min-h-[100dvh] flex-col items-center justify-center bg-[var(--bg)] px-6 py-16 text-center">
      <div className="flex flex-col items-center motion-safe:animate-[comic-pop_240ms_var(--ease-pop)_both]">
        {/* Маскот смотрит вниз — ставим его над кодом ошибки с нахлёстом,
            чтобы взгляд упирался прямо в цифры. */}
        <Image
          src="/mascot/attentive.png"
          alt="Оплатишка озадаченно смотрит вниз"
          width={210}
          height={210}
          priority
          className="relative z-10 -mb-8 w-40 object-contain [filter:drop-shadow(5px_5px_0_rgba(11,10,13,0.45))] sm:w-52"
        />
        <p
          aria-hidden
          className="font-display text-[clamp(6rem,22vw,10rem)] font-bold leading-none text-[var(--color-teal-primary)] [text-shadow:8px_8px_0_var(--shadow-ink)]"
        >
          {code}
        </p>
      </div>

      <h1 className="mt-6 font-display text-2xl font-bold text-[var(--text)] sm:text-3xl">
        {title}
      </h1>
      <p className="mt-2 max-w-md font-body text-base text-[var(--text-muted)]">{text}</p>

      {children && <div className="mt-8 flex flex-wrap items-center justify-center gap-4">{children}</div>}
    </main>
  );
}
