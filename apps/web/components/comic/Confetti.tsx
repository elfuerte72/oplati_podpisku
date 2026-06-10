'use client';

import { useMemo } from 'react';

// Конфетти цветами бренда.
const COLORS = ['#268B89', '#5B9C99', '#FBFCF7', '#6E4E4C', '#2E3A8C', '#C2362F'];

// Детерминированный псевдо-рандом от индекса (чистая функция — не Math.random,
// чтобы не нарушать react-hooks/purity). Разброс достаточный для конфетти.
function rnd(seed: number): number {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Лёгкое self-contained конфетти (без внешних зависимостей) — кульминация
 * оплаты. Под prefers-reduced-motion не рендерится. Родитель монтирует на
 * ~3.5с и снимает.
 */
export function Confetti({ pieces = 64 }: { pieces?: number }) {
  const reduced =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const items = useMemo(() => {
    if (reduced) return [];
    return Array.from({ length: pieces }, (_, i) => ({
      left: rnd(i) * 100,
      delay: rnd(i + 100) * 0.5,
      dur: 2.4 + rnd(i + 200) * 1.4,
      size: 7 + rnd(i + 300) * 7,
      color: COLORS[i % COLORS.length] as string,
    }));
  }, [pieces, reduced]);

  if (items.length === 0) return null;

  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-50 overflow-hidden">
      {items.map((p, i) => (
        <span
          key={i}
          className="absolute top-0 rounded-[2px]"
          style={{
            left: `${p.left}%`,
            width: p.size,
            height: p.size,
            backgroundColor: p.color,
            animationName: 'confetti-fall',
            animationTimingFunction: 'linear',
            animationFillMode: 'forwards',
            animationDelay: `${p.delay}s`,
            animationDuration: `${p.dur}s`,
          }}
        />
      ))}
    </div>
  );
}
