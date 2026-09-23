'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ComicButton } from '@/components/comic/ComicButton';
import { formatRub, formatUsd } from '@/components/comic/format';
import { IconArrowRight } from '@/components/comic/icons';
import { ServiceInstructions } from '@/components/catalog/ServiceInstructions';
import { fetchWithTimeout } from '@/lib/http';
import { track } from '@/lib/analytics/client';
import { cheapestTierKopecks, groupCatalog, type CatalogGroup, type CatalogService } from '@/lib/catalog/build';
import { servicePricingUrl } from '@/lib/catalog/pricing-links';
import { buyerFeeNote } from '@/lib/payments/buyer-fee';
import { parseCustomAmountUsd } from '@/lib/telegram/amount';
import { ServiceLogo } from '@/components/chat/ServiceLogos';

import { doPropose } from './cabinet-api';

/**
 * Кнопочный каталог Mini App: «сервис → тариф/сумма → заказ» — адаптация
 * StartScreen сайта под кабинет (та же витрина GET /api/catalog, но заказ
 * создаётся через POST /api/cabinet `propose` с initData-авторизацией).
 *
 * С вкладками (трек miniapp-tabs, тикет 04) каталог разложен на три части:
 *  - `useCatalog` — загрузка витрины (одна на вкладку и лист сервиса);
 *  - `CatalogGrid` — плитки прямо на вкладке «Оплата», с ценой «от N ₽»;
 *  - `ServicePicker` — содержимое листа сервиса: правила оплаты, тарифы, своя
 *    сумма. Логика создания заказа прежняя; успех отдаёт orderId наверх, и тот
 *    же лист показывает экран заказа.
 */

type CatalogResponse = { ok: boolean; services?: CatalogService[]; buyerFeePercent?: number };

const MIN_AMOUNT_USD = 1;
const MAX_AMOUNT_USD = 500;

// Зеркалит серверный HIGH_VALUE_SERVICE_SLUGS из propose-order.ts (как в
// StartScreen) — держать синхронно.
const HIGH_VALUE_SLUGS = new Set(['airbnb', 'booking', 'steam', 'apple-app-store']);
const HIGH_VALUE_MAX_AMOUNT_USD = 1200;

function maxAmountUsdFor(slug: string): number {
  return HIGH_VALUE_SLUGS.has(slug) ? HIGH_VALUE_MAX_AMOUNT_USD : MAX_AMOUNT_USD;
}

export function formatTierPeriod(period: 'month' | 'quarter' | 'year'): string {
  if (period === 'year') return 'год';
  if (period === 'quarter') return '3 месяца';
  return 'месяц';
}

/**
 * Чистый fetch витрины: `null` — каталог недоступен (сеть/сервер/пустой список).
 * Вместе с сервисами приходит надбавка шлюза на плательщика (0 = её нет).
 */
type CatalogSnapshot = { services: CatalogService[]; buyerFeePercent: number };

async function fetchCatalogOnce(): Promise<CatalogSnapshot | null> {
  try {
    const res = await fetchWithTimeout('/api/catalog');
    const data = (await res.json()) as CatalogResponse;
    if (data.ok && data.services && data.services.length > 0) {
      return { services: data.services, buyerFeePercent: data.buyerFeePercent ?? 0 };
    }
    return null;
  } catch {
    return null;
  }
}

export type CatalogState = {
  groups: CatalogGroup[];
  buyerFeePercent: number;
  loading: boolean;
  failed: boolean;
  retry: () => void;
};

/** Загрузка витрины. `enabled=false` — не ходить в сеть (экран ещё не готов). */
export function useCatalog(enabled: boolean): CatalogState {
  const [catalog, setCatalog] = useState<CatalogService[] | null>(null);
  const [buyerFeePercent, setBuyerFeePercent] = useState(0);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  // Первичная загрузка витрины: setState только после await (тот же паттерн,
  // что инициализация CabinetClient) — иначе react-hooks/set-state-in-effect.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void (async () => {
      const snapshot = await fetchCatalogOnce();
      if (cancelled) return;
      setCatalog(snapshot?.services ?? null);
      setBuyerFeePercent(snapshot?.buyerFeePercent ?? 0);
      setFailed(snapshot === null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const retry = useCallback(() => {
    setLoading(true);
    setFailed(false);
    void fetchCatalogOnce().then((snapshot) => {
      setCatalog(snapshot?.services ?? null);
      setBuyerFeePercent(snapshot?.buyerFeePercent ?? 0);
      setFailed(snapshot === null);
      setLoading(false);
    });
  }, []);

  const groups = useMemo(() => (catalog ? groupCatalog(catalog) : []), [catalog]);
  return { groups, buyerFeePercent, loading, failed, retry };
}

const sectionTitle =
  'font-body text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-muted)]';
const logoPlate =
  'grid size-10 shrink-0 place-items-center rounded-[11px] border-2 border-[var(--shadow-ink)] bg-[var(--color-paper)]';

/** Плитки каталога на вкладке «Оплата»: группы по темам, по две в ряд. */
export function CatalogGrid({
  catalog,
  onSelect,
}: {
  catalog: CatalogState;
  onSelect: (service: CatalogService) => void;
}) {
  if (catalog.loading) {
    return <p className="font-body text-sm text-[var(--text-muted)]">Открываю каталог…</p>;
  }
  if (catalog.failed) {
    return (
      <div className="space-y-3">
        <p className="font-body text-sm text-[var(--text-muted)]">
          Каталог не открылся. Попробуй ещё раз — или напиши боту, что нужно, текстом.
        </p>
        <ComicButton onClick={catalog.retry}>Повторить</ComicButton>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-5">
      {catalog.groups.map((group) => (
        <section key={group.category} className="flex flex-col gap-2.5">
          <h2 className={sectionTitle}>{group.label}</h2>
          <div className="grid grid-cols-2 gap-2.5">
            {group.services.map((svc) => {
              const from = cheapestTierKopecks(svc);
              return (
                <button
                  key={svc.slug}
                  type="button"
                  onClick={() => {
                    track('service_click', {
                      slug: svc.slug,
                      ...(svc.instructions ? { requires_vpn: svc.instructions.requiresVpn } : {}),
                    });
                    onSelect(svc);
                  }}
                  className="flex min-w-0 items-center gap-2.5 rounded-2xl border-[2.5px] border-[var(--shadow-ink)] bg-[var(--surface)] p-3 text-left shadow-[3px_3px_0_var(--shadow-ink)] transition-[transform,box-shadow] active:translate-x-[2px] active:translate-y-[2px] active:shadow-none"
                >
                  <span className={logoPlate}>
                    <ServiceLogo slug={svc.slug} name={svc.name} size={24} />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate font-body text-[15px] font-semibold text-[var(--text)]">
                      {svc.name}
                    </span>
                    <span className="block font-body text-[13px] text-[var(--text-muted)]">
                      {from !== null ? `от ${formatRub(from)}` : 'своя сумма'}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

/** Что выбрано в каталоге — чтобы лист заказа назвал тариф и срок. */
export type OrderHint = {
  tierName?: string;
  period?: 'month' | 'quarter' | 'year';
  usdCents: number;
};

/**
 * Содержимое листа сервиса: правила оплаты картой на сайте, ссылка на прайс,
 * тарифы (главная цифра — рубли, под ней доллары, которые спишет сервис) или
 * ввод своей суммы. Тап по тарифу создаёт заказ (`doPropose`).
 */
export function ServicePicker({
  service,
  initData,
  buyerFeePercent,
  onCreated,
  onOpenExternalLink,
}: {
  service: CatalogService;
  initData: string;
  buyerFeePercent: number;
  onCreated: (orderId: string, hint: OrderHint) => void;
  onOpenExternalLink: (url: string) => void;
}) {
  const [proposing, setProposing] = useState(false);
  const [amount, setAmount] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  // Лист могли закрыть, пока создавался заказ: тогда не открываем его заново
  // поверх вкладки — заказ и так появится в «Ждут оплаты».
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const propose = useCallback(
    async (
      payload: {
        tierName?: string;
        tierPeriod?: 'month' | 'quarter' | 'year';
        amountUsdCents?: number;
      },
      hint: OrderHint,
    ) => {
      if (proposing) return;
      setProposing(true);
      setNotice(null);
      const res = await doPropose(initData, { slug: service.slug, ...payload });
      if (!mountedRef.current) return;
      setProposing(false);
      if (res.ok) {
        onCreated(res.orderId, hint);
      } else {
        setNotice(res.message);
      }
    },
    [proposing, initData, service.slug, onCreated],
  );

  const submitAmount = (e: React.FormEvent) => {
    e.preventDefault();
    // Тот же общий парсер, что в боте и на сайте: «5,000» — это $5000, а не $5.
    const parsed = parseCustomAmountUsd(amount, service.slug);
    const maxUsd = maxAmountUsdFor(service.slug);
    if (parsed.kind !== 'ok') {
      setNotice(`Сумма — от $${MIN_AMOUNT_USD} до $${maxUsd}. Больше? Напиши боту в чат, оформим через оператора.`);
      return;
    }
    void propose({ amountUsdCents: parsed.usdCents }, { usdCents: parsed.usdCents });
  };

  const pricingUrl = servicePricingUrl(service.slug);

  return (
    <div className="flex flex-col gap-4">
      {notice && (
        <p role="alert" className="rounded-[12px] border-2 border-[var(--color-stamp)] px-3 py-2 font-body text-sm text-[var(--color-stamp)]">
          {notice}
        </p>
      )}

      <ServiceInstructions instructions={service.instructions} />

      {pricingUrl && (
        <button
          type="button"
          onClick={() => onOpenExternalLink(pricingUrl)}
          className="inline-flex min-h-9 items-center gap-1 self-start font-body text-sm text-[var(--accent)] underline-offset-2 active:underline"
        >
          Открыть прайс сервиса
          <IconArrowRight size={14} />
        </button>
      )}

      {service.customAmount ? (
        <form onSubmit={submitAmount} className="space-y-3">
          <p className="font-body text-sm text-[var(--text-muted)]">
            У этого сервиса нет фиксированных тарифов — укажи сумму к оплате в долларах
            без НДС (от ${MIN_AMOUNT_USD} до ${maxAmountUsdFor(service.slug)}).
          </p>
          <div className="flex gap-2">
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              placeholder="Например, 120"
              aria-label="Сумма в долларах"
              className="min-w-0 flex-1 rounded-[12px] border-[2.5px] border-[var(--shadow-ink)] bg-[var(--bg)] px-3 py-2 font-body text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none"
            />
            <ComicButton type="submit" disabled={proposing}>
              {proposing ? 'Создаю…' : 'Создать заказ'}
            </ComicButton>
          </div>
        </form>
      ) : (
        <div className="flex flex-col gap-2">
          {service.tiers.map((t) => (
            <button
              key={`${t.name}-${t.period}`}
              type="button"
              disabled={proposing}
              onClick={() => {
                track('plan_select', {
                  slug: service.slug,
                  plan: t.name,
                  amount_usd_cents: t.usdCents,
                });
                void propose(
                  { tierName: t.name, tierPeriod: t.period },
                  { tierName: t.name, period: t.period, usdCents: t.usdCents },
                );
              }}
              className="flex w-full items-center gap-3 rounded-[14px] border-[2.5px] border-[var(--shadow-ink)] bg-[var(--bg)] px-4 py-3 text-left shadow-[3px_3px_0_var(--shadow-ink)] transition-[transform,box-shadow] active:translate-x-[2px] active:translate-y-[2px] active:shadow-none disabled:cursor-not-allowed disabled:opacity-60"
            >
              <span className="min-w-0 flex-1 font-body text-[15px] font-semibold text-[var(--text)]">
                {t.name} · {formatTierPeriod(t.period)}
              </span>
              <span className="flex flex-col items-end leading-tight">
                <span className="font-display text-lg font-bold text-[var(--text)]">
                  {proposing ? '…' : `≈ ${formatRub(t.totalKopecks)}`}
                </span>
                <span className="font-body text-xs text-[var(--text-muted)]">
                  {formatUsd(t.usdCents)} · столько спишет сервис
                </span>
              </span>
              <IconArrowRight size={18} className="shrink-0 text-[var(--text-muted)]" />
            </button>
          ))}
          <p className="font-body text-xs leading-snug text-[var(--text-muted)]">
            <b>≈ ₽</b> — подписка с нашей комиссией по текущему курсу; финальная сумма
            зафиксируется в заказе. <b>$</b> — цена подписки в США: столько сервис спишет с
            виртуальной карты. Если виртуальной карты ещё нет, к первому заказу разово
            добавится её выпуск.
            {buyerFeeNote(buyerFeePercent) !== null && ` ${buyerFeeNote(buyerFeePercent)}`}
          </p>
        </div>
      )}
    </div>
  );
}
