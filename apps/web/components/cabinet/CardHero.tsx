'use client';

import { formatDateWithYear, formatUsd } from '@/components/comic/format';

import type { CardView } from './cabinet-api';

const STATUS_DOT: Record<string, string> = {
  active: 'var(--success)',
  idle: 'var(--color-skin)',
  recycled: 'var(--text-muted)',
};

/**
 * Вид карты клиента на вкладке «Карта» (трек miniapp-tabs, тикет 06): маска
 * номера, статус и баланс — по макету `mockup/Card.dc.html`.
 *
 * Полные реквизиты здесь больше не раскрываются: их показывает лист
 * «Реквизиты карты» (тикет 07) — значения живут, пока открыт лист, а не
 * минуту на главном экране, как было до вкладок.
 */
export function CardVisual({ card }: { card: CardView }) {
  return (
    <div
      className="halftone relative flex aspect-[1.6/1] flex-col justify-between overflow-hidden rounded-[20px] border-[2.5px] border-[var(--shadow-ink)] p-[18px] text-[var(--color-paper)] shadow-[var(--shadow-comic)]"
      style={{ background: 'linear-gradient(135deg, var(--color-teal-deep), var(--color-teal-primary))' }}
    >
      <div className="flex items-start justify-between">
        <span className="font-display text-xl font-bold tracking-tight">Оплатишка</span>
        <span className="inline-flex items-center gap-1.5 rounded-full border-2 border-[var(--shadow-ink)] bg-[var(--color-paper)] px-2.5 py-0.5 font-body text-xs font-bold text-[var(--color-ink)]">
          <span className="size-2 rounded-full" style={{ background: STATUS_DOT[card.status] ?? 'var(--text-muted)' }} />
          {card.statusLabel}
        </span>
      </div>

      <span aria-hidden className="h-[30px] w-[42px] rounded-[7px] border-2 border-[var(--shadow-ink)] bg-[var(--color-skin)]" />

      <p className="font-display text-[22px] font-bold tracking-[0.14em]">{card.panMasked}</p>

      <div className="flex items-end justify-between">
        <span className="font-body text-xs tracking-[0.08em] uppercase opacity-90">Виртуальная карта</span>
        <span className="font-display text-xl font-bold">{formatUsd(card.balanceUsdCents)}</span>
      </div>
    </div>
  );
}

/**
 * Баланс и срок карты. «Действует до» — без времени: срок в месяцах, и часы
 * рядом с ним только шумят (тикет 06).
 *
 * Строка о новой карте говорит заранее, что будет по истечении срока: карта
 * закрывается автоматически (cron `recycle-cards`), и следующая оплата пойдёт по
 * НОВОЙ карте, за выпуск которой берётся надбавка. Отдельных уведомлений перед
 * закрытием осознанно нет (решение владельца) — поэтому строка обязательна.
 */
export function CardFacts({ card }: { card: CardView }) {
  return (
    <div className="flex flex-col gap-3 rounded-[18px] border-[2.5px] border-[var(--shadow-ink)] bg-[var(--surface)] p-4 shadow-[var(--shadow-comic)]">
      <div className="flex justify-between gap-3 font-body text-[15px]">
        <span className="text-[var(--text-muted)]">Баланс</span>
        <span className="tabular-nums text-[var(--text)]">{formatUsd(card.balanceUsdCents)}</span>
      </div>
      <div className="flex justify-between gap-3 font-body text-[15px]">
        <span className="text-[var(--text-muted)]">Действует до</span>
        <span className="tabular-nums text-[var(--text)]">{formatDateWithYear(card.validUntil)}</span>
      </div>
      <p className="font-body text-[13px] leading-snug text-[var(--text-muted)]">
        До этой даты все оплаты идут с этой карты без доплат. Потом выпустим новую — выпуск
        добавится к заказу.
      </p>
    </div>
  );
}
