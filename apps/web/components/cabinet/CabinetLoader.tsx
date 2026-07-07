'use client';

import { Mascot } from '@/components/chat/Mascot';

/**
 * Брендовый сплэш загрузки Mini App вместо простого текста «Загружаю…».
 * Статичный маскот-логотип (без анимации — по просьбе владельца) и три
 * прыгающие teal-точки как индикатор загрузки. Под prefers-reduced-motion
 * точки замирают глобальным правилом — остаётся статичный логотип.
 */
export function CabinetLoader() {
  return (
    <div className="flex min-h-[70vh] w-full flex-col items-center justify-center gap-6 px-6 text-center">
      <Mascot pose="wave" size={128} />
      <span role="status" aria-label="Загрузка" className="flex items-center gap-2">
        {['0s', '0.15s', '0.3s'].map((delay) => (
          <span
            key={delay}
            aria-hidden
            className="h-2.5 w-2.5 rounded-full border-2 border-[var(--shadow-ink)] bg-[var(--accent)] motion-safe:animate-[dot-bounce_1s_ease-in-out_infinite]"
            style={{ animationDelay: delay }}
          />
        ))}
      </span>
    </div>
  );
}
