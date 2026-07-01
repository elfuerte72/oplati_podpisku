'use client';

import Image from 'next/image';
import { useCallback, useMemo, useState } from 'react';

import { ComicButton } from '@/components/comic';
import { formatRub } from '@/components/comic/format';
import { fetchWithTimeout } from '@/lib/http';
import { groupCatalog, type CatalogService } from '@/lib/catalog/build';

import { ServiceLogo } from './ServiceLogos';
import type { ChatCard } from './toolCards';

/**
 * Стартовый экран чата (пока диалога нет): hero-приветствие display-шрифтом
 * (не облако-сообщение) + разворачиваемый список сервисов с логотипами +
 * «Свой вариант» (раскрывает поле ввода → обычный чат с агентом).
 *
 * Happy path «сервис → тариф → заказ» идёт мимо AI: каталог и цены —
 * GET /api/catalog, заказ — POST /api/orders/propose (решение владельца
 * 2026-06-12). Для custom-amount сервисов (Airbnb) вместо тарифов — поле
 * суммы в долларах.
 */

type OrderCard = Extract<ChatCard, { type: 'order' }>;

type CatalogResponse = { ok: boolean; services?: CatalogService[] };
type ProposeResponse = { ok: boolean; card?: Omit<OrderCard, 'type'>; text?: string };

const PROPOSE_FAIL_TEXT =
  'Не получилось создать заказ. Попробуйте ещё раз или напишите в чат — подключу оператора.';

const MIN_AMOUNT_USD = 1;
const MAX_AMOUNT_USD = 500;

// Сервисы-пополнения с крупной индивидуальной ценой (Airbnb/Booking/Steam)
// допускают суммы до HIGH_VALUE_MAX_AMOUNT_USD. Зеркалит серверный
// HIGH_VALUE_SERVICE_SLUGS из propose-order.ts — держать синхронно.
const HIGH_VALUE_SLUGS = new Set(['airbnb', 'booking', 'steam']);
const HIGH_VALUE_MAX_AMOUNT_USD = 5000;

function maxAmountUsdFor(slug: string): number {
  return HIGH_VALUE_SLUGS.has(slug) ? HIGH_VALUE_MAX_AMOUNT_USD : MAX_AMOUNT_USD;
}

function formatTierPeriod(period: 'month' | 'quarter' | 'year'): string {
  if (period === 'year') return 'год';
  if (period === 'quarter') return '3 месяца';
  return 'месяц';
}

type StartScreenProps = {
  onOrderCreated: (card: OrderCard) => void;
  onOwnVariant: () => void;
  onError: (text: string) => void;
  onListOpen?: () => void;
};

export function StartScreen({ onOrderCreated, onOwnVariant, onError, onListOpen }: StartScreenProps) {
  const [listOpen, setListOpen] = useState(false);
  const [catalog, setCatalog] = useState<CatalogService[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<CatalogService | null>(null);
  const [proposing, setProposing] = useState(false);
  const [amount, setAmount] = useState('');
  const [amountError, setAmountError] = useState<string | null>(null);

  const loadCatalog = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const res = await fetchWithTimeout('/api/catalog');
      const data = (await res.json()) as CatalogResponse;
      if (data.ok && data.services && data.services.length > 0) {
        setCatalog(data.services);
      } else {
        setFailed(true);
      }
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  const openList = useCallback(() => {
    setListOpen(true);
    onListOpen?.();
    if (!catalog) void loadCatalog();
  }, [catalog, loadCatalog, onListOpen]);

  const propose = useCallback(
    async (
      slug: string,
      payload: { tierName?: string; tierPeriod?: 'month' | 'quarter' | 'year'; amountUsdCents?: number },
    ) => {
      if (proposing) return;
      setProposing(true);
      try {
        const res = await fetchWithTimeout(
          '/api/orders/propose',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ slug, ...payload }),
          },
          20_000,
        );
        const data = (await res.json()) as ProposeResponse;
        if (data.ok && data.card) {
          onOrderCreated({ type: 'order', ...data.card });
        } else {
          onError(data.text ?? PROPOSE_FAIL_TEXT);
        }
      } catch {
        onError('Нет связи. Проверьте интернет и попробуйте ещё раз.');
      } finally {
        setProposing(false);
      }
    },
    [proposing, onOrderCreated, onError],
  );

  const submitAmount = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    const usd = Number(amount.replace(',', '.'));
    const maxUsd = maxAmountUsdFor(selected.slug);
    if (!Number.isFinite(usd) || usd < MIN_AMOUNT_USD || usd > maxUsd) {
      setAmountError(`Сумма — от $${MIN_AMOUNT_USD} до $${maxUsd}. Больше? Напишите в чат, оформим через оператора.`);
      return;
    }
    setAmountError(null);
    void propose(selected.slug, { amountUsdCents: Math.round(usd * 100) });
  };

  const groups = useMemo(() => (catalog ? groupCatalog(catalog) : []), [catalog]);

  const tilePlate =
    'grid h-9 w-9 shrink-0 place-items-center rounded-xl border-2 border-[var(--shadow-ink)] bg-[var(--color-paper)]';
  const tile =
    'flex items-center gap-2.5 rounded-[var(--radius-card)] border-[2.5px] border-[var(--shadow-ink)] bg-[var(--surface)] px-3 py-2.5 text-left shadow-[var(--shadow-comic)] transition-[transform,box-shadow] hover:-translate-y-0.5 hover:shadow-[var(--shadow-comic-lg)] active:translate-x-[2px] active:translate-y-[2px] active:shadow-none disabled:cursor-not-allowed disabled:opacity-60';

  return (
    <div className="flex min-h-[55dvh] flex-col items-center justify-center gap-6 py-6 text-center">
      {!listOpen && (
        <div className="flex flex-col items-center gap-6">
          <Image
            src="/intro/services.webp"
            alt="Логотипы сервисов: ChatGPT, Claude, Spotify, Netflix, YouTube, Airbnb — и любой другой"
            width={1200}
            height={1191}
            priority
            sizes="(min-width: 640px) 360px, 70vw"
            className="w-full max-w-[260px] sm:max-w-[340px] [filter:drop-shadow(4px_4px_0_rgba(11,10,13,0.35))]"
          />
          <ComicButton onClick={openList}>Выбрать сервис</ComicButton>
        </div>
      )}

      {listOpen && !selected && loading && (
        <p className="font-body text-sm text-[var(--text-muted)]">Открываю каталог…</p>
      )}

      {listOpen && !selected && !loading && failed && (
        <div className="space-y-3">
          <p className="font-body text-sm text-[var(--text-muted)]">
            Каталог не открылся. Попробуйте ещё раз — или напишите, что нужно, текстом.
          </p>
          <div className="flex justify-center gap-3">
            <ComicButton onClick={() => void loadCatalog()}>Повторить</ComicButton>
            <ComicButton onClick={onOwnVariant}>Написать текстом</ComicButton>
          </div>
        </div>
      )}

      {listOpen && !selected && !loading && !failed && catalog && (
        <div className="w-full max-w-xl space-y-5">
          {groups.map((group) => (
            <section key={group.category} className="space-y-2">
              <h3 className="px-1 text-left font-display text-xs font-bold uppercase tracking-wide text-[var(--text-muted)]">
                {group.label}
              </h3>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {group.services.map((svc) => (
                  <button
                    key={svc.slug}
                    type="button"
                    disabled={proposing}
                    onClick={() => {
                      setSelected(svc);
                      setAmount('');
                      setAmountError(null);
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

          <button type="button" onClick={onOwnVariant} className={`${tile} w-full`}>
            <span className={tilePlate}>
              <span aria-hidden className="font-display text-xl font-bold text-[var(--color-ink)]">
                +
              </span>
            </span>
            <span className="min-w-0 font-body text-sm font-semibold leading-tight text-[var(--accent)]">
              Свой вариант…
            </span>
          </button>
        </div>
      )}

      {selected && (
        <div className="w-full max-w-md rounded-[var(--radius-card)] border-[2.5px] border-[var(--shadow-ink)] bg-[var(--surface)] p-5 text-left shadow-[var(--shadow-comic-lg)]">
          <button
            type="button"
            onClick={() => setSelected(null)}
            className="font-body text-sm text-[var(--text-muted)] transition-colors hover:text-[var(--text)]"
          >
            ← Назад к списку
          </button>

          <div className="mt-3 flex items-center gap-3">
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

          <p className="mt-4 font-body text-xs leading-snug text-[var(--text-muted)]">
            Платим американской картой без НДС. Включите на сайте сервиса VPN с локацией
            США — иначе из-за локации спишется больше (например, подписка $100 обойдётся в $111).
          </p>

          {selected.customAmount ? (
            <form onSubmit={submitAmount} className="mt-4 space-y-3">
              <p className="font-body text-sm text-[var(--text-muted)]">
                У этого сервиса нет фиксированных тарифов — укажите сумму к оплате в долларах
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
              {amountError && (
                <p role="alert" className="font-body text-sm text-[var(--color-stamp)]">
                  {amountError}
                </p>
              )}
            </form>
          ) : (
            <div className="mt-4 space-y-2">
              {selected.tiers.map((t) => (
                <button
                  key={`${t.name}-${t.period}`}
                  type="button"
                  disabled={proposing}
                  onClick={() => void propose(selected.slug, { tierName: t.name, tierPeriod: t.period })}
                  className="flex w-full items-center justify-between gap-3 rounded-[12px] border-[2.5px] border-[var(--shadow-ink)] bg-[var(--bg)] px-4 py-3 shadow-[2px_2px_0_var(--shadow-ink)] transition-[transform,box-shadow] hover:-translate-y-0.5 active:translate-x-[2px] active:translate-y-[2px] active:shadow-none disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <span className="font-body text-sm font-semibold text-[var(--text)]">
                    {t.name} · {formatTierPeriod(t.period)}
                  </span>
                  <span className="font-display text-lg font-bold text-[var(--accent)]">
                    {proposing ? '…' : formatRub(t.totalKopecks)}
                  </span>
                </button>
              ))}
              <p className="font-body text-xs text-[var(--text-muted)]">
                Цена с комиссией по текущему курсу; финальная сумма зафиксируется в заказе.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
