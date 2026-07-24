import Link from 'next/link';
import type { ReactNode } from 'react';

import { IconArrowLeft } from '@/components/comic/icons';

/**
 * Каркас информационных страниц (/about, /terms, /privacy): комикс-шапка со
 * ссылкой на главную, заголовок, дата редакции (обязательна на юридических
 * документах — требование платёжного провайдера) и контентная колонка.
 * RSC без клиентского JS; стили — только токены комикс-системы.
 */
export function InfoShell({
  title,
  updatedAt,
  children,
}: {
  title: string;
  /** «Редакция от …» — видимая дата документа под заголовком. */
  updatedAt?: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-dvh">
      <header className="border-b-[2.5px] border-[var(--shadow-ink)] bg-[var(--surface)]">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3 px-4 py-3">
          <Link
            href="/"
            className="inline-flex items-center gap-2 rounded-[12px] border-[2.5px] border-[var(--shadow-ink)] bg-[var(--bg)] px-3 py-1.5 font-display text-sm font-bold text-[var(--text)] shadow-[2px_2px_0_var(--shadow-ink)] transition-[transform,box-shadow] active:translate-x-[2px] active:translate-y-[2px] active:shadow-none"
          >
            <IconArrowLeft size={16} className="shrink-0" />
            На главную
          </Link>
          <span className="wordmark font-display text-lg font-bold leading-none">Оплатишка</span>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl px-4 py-8 pb-14">
        <h1 className="font-display text-3xl font-bold leading-tight text-[var(--text)]">{title}</h1>
        {updatedAt && (
          <p className="mt-3 inline-block rounded-full border-2 border-[var(--shadow-ink)] bg-[var(--surface-2)] px-3 py-1 font-body text-xs font-semibold text-[var(--text-muted)]">
            Редакция от {updatedAt}
          </p>
        )}
        <div className="mt-6 space-y-5">{children}</div>
      </main>
    </div>
  );
}

/**
 * Секция документа: комикс-карточка с заголовком. Внутренним <p>/<ul>/<a>
 * базовые стили раздаются селекторами контейнера — без повторения классов
 * на каждом абзаце длинного юридического текста.
 */
export function InfoSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-[var(--radius-card)] border-[2.5px] border-[var(--shadow-ink)] bg-[var(--surface)] p-5 shadow-[var(--shadow-comic)]">
      <h2 className="font-display text-lg font-bold text-[var(--text)]">{title}</h2>
      <div className="mt-3 space-y-3 font-body text-[15px] leading-relaxed text-[var(--text)] [&_a]:font-semibold [&_a]:text-[var(--accent)] [&_a]:underline [&_li]:ml-5 [&_li]:list-disc [&_ul]:space-y-1.5">
        {children}
      </div>
    </section>
  );
}
