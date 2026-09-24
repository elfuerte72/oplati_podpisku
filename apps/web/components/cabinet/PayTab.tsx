'use client';

import Image from 'next/image';

import { IconArrowRight } from '@/components/comic/icons';
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

      {onContactSupport && <SupportCard onClick={onContactSupport} />}
    </div>
  );
}

/**
 * «Нет нужного сервиса?» — карточкой в стиле бренда, а не строкой текста:
 * это единственный выход для клиента, который не нашёл свой сервис в
 * каталоге, и серой ссылкой под каталогом его не замечали. Маскот в гарнитуре
 * (бюст из `support.webp`, 18 КБ вместо 120) стоит на нижней кромке — других
 * маскотов на «Оплате» нет, правило «один на экране» соблюдено.
 */
function SupportCard({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-end gap-3 overflow-hidden rounded-[18px] border-[2.5px] border-[var(--shadow-ink)] bg-[var(--color-teal-deep)] pr-3.5 text-left shadow-[var(--shadow-comic)] transition-[transform,box-shadow] active:translate-x-[3px] active:translate-y-[3px] active:shadow-none"
    >
      <Image
        src="/mascot/support-bust.webp"
        alt=""
        width={96}
        height={96}
        className="size-24 shrink-0 self-end"
      />
      <span className="flex min-w-0 flex-1 flex-col items-start gap-2 self-center py-3.5">
        <span>
          <span className="block font-display text-[18px] leading-tight font-bold text-[var(--color-paper)]">
            Нет нужного сервиса?
          </span>
          <span className="mt-0.5 block font-body text-[13px] leading-snug text-[color-mix(in_srgb,var(--color-paper)_82%,transparent)]">
            Напиши нам — проверим, можно ли его оплатить
          </span>
        </span>
        <span className="inline-flex items-center gap-1 rounded-full border-2 border-[var(--shadow-ink)] bg-[var(--color-paper)] px-3 py-1.5 font-display text-sm font-bold text-[var(--color-ink)]">
          Написать в поддержку
          <IconArrowRight size={14} />
        </span>
      </span>
    </button>
  );
}
