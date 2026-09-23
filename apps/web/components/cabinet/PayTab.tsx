'use client';

import type { CatalogService } from '@/lib/catalog/build';

import type { OrderSummary } from './cabinet-api';
import { CatalogGrid, type CatalogState } from './CatalogView';
import { PendingOrdersList } from './PendingOrdersList';

/**
 * Вкладка «Оплата» (трек miniapp-tabs, тикет 04), вид — `mockup/Main.dc.html`.
 *
 * Каталог теперь прямо на вкладке, с ценой «от N ₽» на плитке, а не за кнопкой
 * «Выбрать сервис»; модель «платишь рублями → получаешь карту → сам оплачиваешь»
 * видна полоской в момент выбора. Тап по сервису или по заказу — лист.
 */

const STEPS = ['Платишь рублями', 'Получаешь карту в долларах', 'Сам оплачиваешь сервис'] as const;

export function PayTab({
  greeting,
  pendingOrders,
  catalog,
  onOpenOrder,
  onOpenService,
  onOpenIntro,
  onContactSupport,
}: {
  greeting: string;
  pendingOrders: readonly OrderSummary[];
  catalog: CatalogState;
  onOpenOrder: (orderId: string) => void;
  onOpenService: (service: CatalogService) => void;
  onOpenIntro: () => void;
  /** Закрыть Mini App и вернуться в чат бота; не задан — ссылки нет. */
  onContactSupport?: (() => void) | undefined;
}) {
  return (
    <div className="flex flex-col gap-5">
      <header className="pt-1">
        <h1 className="font-display text-[26px] leading-tight font-bold text-[var(--text)]">{greeting}</h1>
        <p className="mt-0.5 font-body text-sm text-[var(--text-muted)]">Что оплатим сегодня?</p>
      </header>

      <PendingOrdersList orders={pendingOrders} onOpen={onOpenOrder} />

      <section
        aria-label="Как это работает"
        className="flex flex-col gap-2.5 rounded-2xl border-2 border-dashed border-[color-mix(in_srgb,var(--text-muted)_35%,transparent)] p-3.5"
      >
        <ol className="flex items-stretch gap-2">
          {STEPS.map((text, i) => (
            <li key={text} className="flex flex-1 basis-0 flex-col gap-0.5">
              <span className="font-display font-bold text-[var(--accent)]">{i + 1}</span>
              <span className="font-body text-[13px] leading-snug text-[var(--text)]">{text}</span>
            </li>
          ))}
        </ol>
        <button
          type="button"
          onClick={onOpenIntro}
          className="self-start font-body text-[13px] text-[var(--accent)] underline-offset-2 active:underline"
        >
          Как это работает — подробнее
        </button>
      </section>

      <CatalogGrid catalog={catalog} onSelect={onOpenService} />

      {onContactSupport && (
        <button
          type="button"
          onClick={onContactSupport}
          className="flex min-h-11 items-center self-center font-body text-sm text-[var(--text-muted)] underline underline-offset-[3px]"
        >
          Нет нужного сервиса? Напиши в поддержку
        </button>
      )}
    </div>
  );
}
