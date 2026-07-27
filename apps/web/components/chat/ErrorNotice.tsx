'use client';

import { useEffect, useState } from 'react';

import { z } from 'zod';

import { fetchWithTimeout, parseJsonSafe } from '@/lib/http';
import { TelegramIcon } from './TelegramLink';

/**
 * Плашка ошибки кнопочных действий чата (создание счёта, привязка) со ссылкой
 * на поддержку.
 *
 * Зачем ссылка: самый частый текст здесь — «оплата временно недоступна,
 * попробуй через несколько минут». Если шлюз лёг всерьёз, повтор не поможет, и
 * клиент упирается в тупик, из которого нет выхода, кроме как уйти. Поддержка
 * живёт в Telegram-боте (`/support`), поэтому ведём туда.
 *
 * URL бота — `supportUrl` из `/api/profile` (тот же источник, что у
 * MobileTelegramBanner). Best-effort: нет ответа или не задан токен бота →
 * показываем только текст ошибки, как было раньше.
 */

const profileResponseSchema = z.object({ supportUrl: z.string().nullable().optional() });

export function ErrorNotice({ text }: { text: string }) {
  const [supportUrl, setSupportUrl] = useState<string | null>(null);

  useEffect(() => {
    void fetchWithTimeout('/api/profile', {}, 5000)
      .then((res) => parseJsonSafe(res, profileResponseSchema))
      .then((data) => setSupportUrl(data?.supportUrl ?? null))
      .catch(() => {
        // Не критично: без ссылки плашка остаётся прежней текстовой.
      });
  }, []);

  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-2 rounded-[12px] border-2 border-[var(--color-stamp)] bg-[var(--surface-2)] px-3 py-2"
    >
      <p className="font-body text-sm text-[var(--text)]">{text}</p>
      {supportUrl && (
        <a
          href={supportUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-[10px] border-2 border-[var(--shadow-ink)] bg-[var(--surface)] px-2.5 py-1 font-display text-xs text-[var(--text)] transition-transform hover:-translate-y-px"
        >
          <TelegramIcon className="h-3.5 w-3.5" />
          Написать в поддержку
        </a>
      )}
    </div>
  );
}
