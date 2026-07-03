'use client';

import { useEffect, useState } from 'react';

import { z } from 'zod';

import { comicButtonClassName } from '@/components/comic';
import { fetchWithTimeout, parseJsonSafe } from '@/lib/http';
import { TelegramIcon } from './TelegramLink';

/**
 * Мобильный CTA «Продолжить в Telegram» над шапкой чата.
 *
 * Основной канал продукта — Telegram-бот с Mini App; мобильный сайт — воронка
 * в него. Прямая `<a>` на `t.me/<bot>?start=site` нативно открывает приложение
 * (universal link срабатывает только от прямого тапа — тот же принцип, что в
 * TelegramLink.tsx). URL бота берём из /api/profile (`supportUrl`) — эндпоинт
 * уже существует и best-effort: нет ответа → баннер просто не показываем.
 *
 * Анти-петля: кнопка «Сайт» в /start-меню бота ведёт на `/?src=tg` — такому
 * визиту баннер не показываем (человек осознанно пришёл ИЗ Telegram смотреть
 * сайт), флаг живёт в sessionStorage на всю вкладку.
 */

const FROM_TG_STORAGE_KEY = 'oplatishka_from_tg';

// Zod на границе (конвенция проекта): интересует только supportUrl.
const profileResponseSchema = z.object({ supportUrl: z.string().nullable().optional() });

export function MobileTelegramBanner() {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    // Десктоп: баннер скрыт (lg:hidden) — и не тратим запрос на URL бота.
    if (window.matchMedia('(min-width: 1024px)').matches) return;

    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get('src') === 'tg') {
        window.sessionStorage.setItem(FROM_TG_STORAGE_KEY, '1');
      }
      if (window.sessionStorage.getItem(FROM_TG_STORAGE_KEY) !== null) return;
    } catch {
      // sessionStorage недоступен (приватный режим) — ведём себя как обычный визит
    }

    void fetchWithTimeout('/api/profile', {}, 5000)
      .then((res) => parseJsonSafe(res, profileResponseSchema))
      .then((data) => setUrl(data?.supportUrl ?? null))
      .catch(() => {
        // не критично: баннер — навигационный сахар, без него сайт работает
      });
  }, []);

  if (!url) return null;

  return (
    <div className="flex shrink-0 items-center justify-between gap-3 border-b-[2.5px] border-[var(--shadow-ink)] bg-[var(--surface-2)] px-4 py-2.5 lg:hidden">
      <p className="font-body text-xs leading-snug text-[var(--text-muted)]">
        В Telegram удобнее: каталог, оплата и чеки в одном месте.
      </p>
      <a
        href={url}
        className={comicButtonClassName(
          'primary',
          'inline-flex shrink-0 items-center gap-1.5 px-3.5 py-2 text-sm',
        )}
      >
        <TelegramIcon className="h-4 w-4 shrink-0" />
        Открыть
      </a>
    </div>
  );
}
