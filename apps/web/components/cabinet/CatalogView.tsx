'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { ComicButton } from '@/components/comic/ComicButton';
import { formatRub, formatUsd } from '@/components/comic/format';
import { IconArrowLeft } from '@/components/comic/icons';
import { ServiceInstructions } from '@/components/catalog/ServiceInstructions';
import { ServicePricingButton } from '@/components/catalog/ServicePricingButton';
import { fetchWithTimeout } from '@/lib/http';
import { groupCatalog, type CatalogService } from '@/lib/catalog/build';
import { buyerFeeNote } from '@/lib/payments/buyer-fee';
import { ServiceLogo } from '@/components/chat/ServiceLogos';

import { doPropose } from './cabinet-api';

/**
 * Кнопочный каталог Mini App: «сервис → тариф/сумма → заказ» — адаптация
 * StartScreen сайта под кабинет (та же витрина GET /api/catalog, но заказ
 * создаётся через POST /api/cabinet `propose` с initData-авторизацией).
 * Успех — отдаём orderId наверх: CabinetClient открывает деталь заказа,
 * где уже есть кнопка «Оплатить» (существующий flow оплаты).
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

function formatTierPeriod(period: 'month' | 'quarter' | 'year'): string {
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

type CatalogViewProps = {
  initData: string;
  onBack: () => void;
  onCreated: (orderId: string) => void;
  onOpenExternalLink: (url: string) => void;
};

export function CatalogView({
  initData,
  onBack,
  onCreated,
  onOpenExternalLink,
}: CatalogViewProps) {
  const [catalog, setCatalog] = useState<CatalogService[] | null>(null);
  const [buyerFeePercent, setBuyerFeePercent] = useState(0);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<CatalogService | null>(null);
  const [proposing, setProposing] = useState(false);
  const [amount, setAmount] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  // Первичная загрузка витрины: setState только после await (тот же паттерн,
  // что инициализация CabinetClient) — иначе react-hooks/set-state-in-effect.
  useEffect(() => {
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
  }, []);

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

  const propose = useCallback(
    async (
      slug: string,
      payload: {
        tierName?: string;
        tierPeriod?: 'month' | 'quarter' | 'year';
        amountUsdCents?: number;
      },
    ) => {
      if (proposing) return;
      setProposing(true);
      setNotice(null);
      const res = await doPropose(initData, { slug, ...payload });
      setProposing(false);
      if (res.ok) {
        onCreated(res.orderId);
      } else {
        setNotice(res.message);
      }
    },
    [proposing, initData, onCreated],
  );

  const submitAmount = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    const usd = Number(amount.replace(',', '.'));
    const maxUsd = maxAmountUsdFor(selected.slug);
    if (!Number.isFinite(usd) || usd < MIN_AMOUNT_USD || usd > maxUsd) {
      setNotice(`Сумма — от $${MIN_AMOUNT_USD} до $${maxUsd}. Больше? Напиши боту в чат, оформим через оператора.`);
      return;
    }
    void propose(selected.slug, { amountUsdCents: Math.round(usd * 100) });
  };

  const groups = useMemo(() => (catalog ? groupCatalog(catalog) : []), [catalog]);
  const tilePlate =
    'grid h-9 w-9 shrink-0 place-items-center rounded-xl border-2 border-[var(--shadow-ink)] bg-[var(--color-paper)]';
  const tile =
    'flex items-center gap-2.5 rounded-[var(--radius-card)] border-[2.5px] border-[var(--shadow-ink)] bg-[var(--surface)] px-3 py-2.5 text-left shadow-[var(--shadow-comic)] transition-[transform,box-shadow] active:translate-x-[2px] active:translate-y-[2px] active:shadow-none disabled:cursor-not-allowed disabled:opacity-60';

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={selected ? () => { setSelected(null); setNotice(null); } : onBack}
        className="inline-flex items-center gap-1 font-display text-sm font-bold text-[var(--link)]"
      >
        <IconArrowLeft size={16} />
        {selected ? 'Назад к списку' : 'В кабинет'}
      </button>

      {!selected && (
        <h1 className="font-display text-xl font-bold text-[var(--text)]">Что оплатить?</h1>
      )}

      {notice && (
        <p role="alert" className="rounded-[12px] border-2 border-[var(--color-stamp)] px-3 py-2 font-body text-sm text-[var(--color-stamp)]">
          {notice}
        </p>
      )}

      {loading && (
        <p className="font-body text-sm text-[var(--text-muted)]">Открываю каталог…</p>
      )}

      {!loading && failed && (
        <div className="space-y-3">
          <p className="font-body text-sm text-[var(--text-muted)]">
            Каталог не открылся. Попробуй ещё раз — или напиши боту, что нужно, текстом.
          </p>
          <ComicButton onClick={retry}>Повторить</ComicButton>
        </div>
      )}

      {!loading && !failed && catalog && !selected && (
        <div className="space-y-5">
          {groups.map((group) => (
            <section key={group.category} className="space-y-2">
              <h2 className="px-1 text-left font-display text-xs font-bold uppercase tracking-wide text-[var(--text-muted)]">
                {group.label}
              </h2>
              <div className="grid grid-cols-2 gap-2.5">
                {group.services.map((svc) => (
                  <button
                    key={svc.slug}
                    type="button"
                    disabled={proposing}
                    onClick={() => {
                      setSelected(svc);
                      setAmount('');
                      setNotice(null);
                    }}
                    className={tile}
                  >
                    <span className={tilePlate}>
                      <ServiceLogo slug={svc.slug} name={svc.name} size={24} />
                    </span>
                    <span className="min-w-0 font-body text-sm font-semibold leading-tight text-[var(--text)]">
                      {svc.name}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {selected && (
        <div className="rounded-[var(--radius-card)] border-[2.5px] border-[var(--shadow-ink)] bg-[var(--surface)] p-5 text-left shadow-[var(--shadow-comic-lg)]">
          <div className="flex items-center gap-3">
            <span className={tilePlate}>
              <ServiceLogo slug={selected.slug} name={selected.name} size={24} />
            </span>
            <div>
              <p className="font-display text-lg font-bold leading-tight text-[var(--text)]">
                {selected.name}
              </p>
              {selected.requiresKyc && (
                <p className="font-body text-xs text-[var(--text-muted)]">
                  может понадобиться верификация (KYC)
                </p>
              )}
            </div>
          </div>

          <ServiceInstructions instructions={selected.instructions} className="mt-4" />

          <ServicePricingButton
            slug={selected.slug}
            onOpenExternalLink={onOpenExternalLink}
          />

          {selected.customAmount ? (
            <form onSubmit={submitAmount} className="mt-4 space-y-3">
              <p className="font-body text-sm text-[var(--text-muted)]">
                У этого сервиса нет фиксированных тарифов — укажи сумму к оплате в долларах
                без НДС (от ${MIN_AMOUNT_USD} до ${maxAmountUsdFor(selected.slug)}).
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
            <div className="mt-4 space-y-2">
              {selected.tiers.map((t) => (
                <button
                  key={`${t.name}-${t.period}`}
                  type="button"
                  disabled={proposing}
                  onClick={() => void propose(selected.slug, { tierName: t.name, tierPeriod: t.period })}
                  className="flex w-full items-center justify-between gap-3 rounded-[12px] border-[2.5px] border-[var(--shadow-ink)] bg-[var(--bg)] px-4 py-3 shadow-[2px_2px_0_var(--shadow-ink)] transition-[transform,box-shadow] active:translate-x-[2px] active:translate-y-[2px] active:shadow-none disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <span className="font-body text-sm font-semibold text-[var(--text)]">
                    {t.name} · {formatTierPeriod(t.period)}
                  </span>
                  <span className="flex flex-col items-end leading-tight">
                    <span className="font-display text-lg font-bold text-[var(--accent)]">
                      {formatUsd(t.usdCents)}
                    </span>
                    <span className="font-body text-xs text-[var(--text-muted)]">
                      {proposing ? '…' : `≈ ${formatRub(t.totalKopecks)}`}
                    </span>
                  </span>
                </button>
              ))}
              <p className="font-body text-xs text-[var(--text-muted)]">
                <b>$</b> — цена подписки в США (столько вводишь на сайте сервиса). <b>≈ ₽</b> —
                подписка с нашей комиссией по текущему курсу; финальная сумма
                зафиксируется в заказе. Если виртуальной карты ещё нет, к первому заказу
                разово добавится её выпуск.
                {buyerFeeNote(buyerFeePercent) !== null && ` ${buyerFeeNote(buyerFeePercent)}`}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
