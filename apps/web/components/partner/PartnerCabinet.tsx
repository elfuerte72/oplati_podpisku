'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useCallback, useEffect, useState, type CSSProperties } from 'react';

import { ComicButton } from '@/components/comic/ComicButton';
import { mascotSrc } from '@/components/chat/Mascot';
import type {
  ReferralHistoryEntry,
  ReferralSnapshot,
} from '@/lib/cabinet/referral-types';

import { fetchReferralSnapshot, requestPayout } from './partner-api';
import { formatBps, formatLedgerDate, formatMonthShort, formatUsd } from './format-usd';

/**
 * Партнёрский кабинет «Оплатишка» — комикс-нуар. Приоритетная поверхность —
 * сайт `/partner` (auth по cookie). Тот же компонент переиспользует мини-апп
 * (D3), передавая `initData`. Дизайн — skill oplatishka-design (контур + жёсткая
 * тень, halftone, маскот, штампы). Показываем только реальные данные снапшота.
 *
 * Программа одноуровневая (упрощение 2026-07-02): партнёр видит одну ставку,
 * одну сводку рефералов и единственную ссылку-приглашение — Telegram deep-link.
 */

type Screen = 'dashboard' | 'network' | 'link' | 'history' | 'stats';
type Phase = 'loading' | 'error' | 'disabled' | 'ready';

const NAV: { key: Screen; icon: string; label: string }[] = [
  { key: 'dashboard', icon: '🏠', label: 'Дашборд' },
  { key: 'network', icon: '👥', label: 'Рефералы' },
  { key: 'link', icon: '🔗', label: 'Ссылка' },
  { key: 'history', icon: '🧾', label: 'История' },
  { key: 'stats', icon: '📈', label: 'Статистика' },
];

// Локальные акценты — бренд-токены (teal-light / glasses-light).
const ACCENT_VARS: CSSProperties = {
  ['--acc' as string]: 'var(--color-teal-light)',
  ['--acc2' as string]: 'var(--link)',
};

const CARD =
  'rounded-[var(--radius-card)] border-[2.5px] border-[var(--shadow-ink)] bg-[var(--surface)] shadow-[var(--shadow-comic)]';
const SOFT =
  'rounded-[14px] border-[2.5px] border-[var(--shadow-ink)] bg-[var(--surface-2)]';

export function PartnerCabinet({
  initData,
  previewSnapshot,
  initialScreen,
  onBack,
}: {
  initData?: string;
  /** Тест/превью-seam: если задан — рендерим без сетевого запроса. */
  previewSnapshot?: ReferralSnapshot;
  /** Тест/превью-seam: стартовый экран (по умолчанию дашборд). */
  initialScreen?: Screen;
  /** Если задан — в топбаре кнопка «назад» (мини-апп: возврат к заказам). */
  onBack?: () => void;
} = {}) {
  const [phase, setPhase] = useState<Phase>(previewSnapshot ? 'ready' : 'loading');
  const [snap, setSnap] = useState<ReferralSnapshot | null>(previewSnapshot ?? null);
  const [screen, setScreen] = useState<Screen>(initialScreen ?? 'dashboard');
  const [modalOpen, setModalOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetchReferralSnapshot(initData);
    if (res.ok) {
      setSnap(res.snapshot);
      setPhase(res.snapshot.enabled ? 'ready' : 'disabled');
    } else {
      setPhase('error');
    }
  }, [initData]);

  // Первичная загрузка — async-IIFE с cancel-guard (как CabinetClient): setState
  // только после await, не синхронно в теле эффекта. `load` переиспользуется для
  // refetch после вывода (вызывается из обработчика, не из эффекта).
  useEffect(() => {
    if (previewSnapshot) return;
    let cancelled = false;
    void (async () => {
      const res = await fetchReferralSnapshot(initData);
      if (cancelled) return;
      if (res.ok) {
        setSnap(res.snapshot);
        setPhase(res.snapshot.enabled ? 'ready' : 'disabled');
      } else {
        setPhase('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initData, previewSnapshot]);

  const showToast = useCallback((text: string) => {
    setToast(text);
    setTimeout(() => setToast(null), 2800);
  }, []);

  if (phase === 'loading') return <Centered text="Открываю партнёрский кабинет…" onBack={onBack} />;
  if (phase === 'error')
    return <Centered title="Что-то пошло не так" text="Попробуй обновить страницу." onBack={onBack} />;
  if (phase === 'disabled' || !snap) {
    return (
      <Centered
        title="Партнёрская программа скоро"
        text="Мы готовим кабинет к запуску. Загляни немного позже — здесь появятся твоя сеть, ставки и баланс."
        onBack={onBack}
      />
    );
  }

  const title = NAV.find((n) => n.key === screen)?.label ?? '';

  return (
    <div className="halftone min-h-screen w-full min-w-0 overflow-x-hidden bg-[var(--bg)] text-[var(--text)]" style={ACCENT_VARS}>
      <div className="mx-auto flex w-full min-w-0 max-w-[1180px]">
        {/* ── Sidebar (desktop) ── */}
        <aside className="sticky top-0 hidden h-screen w-[232px] shrink-0 flex-col border-r-[2.5px] border-[var(--shadow-ink)] bg-[var(--surface)] py-5 lg:flex">
          <div className="flex items-center gap-2.5 px-4 pb-4">
            <span className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-[12px] border-[2.5px] border-[var(--shadow-ink)] bg-[var(--color-teal-primary)] shadow-[2px_2px_0_var(--shadow-ink)]">
              <Image src={mascotSrc('idle')} alt="Оплатишка" width={40} height={40} className="h-full w-full object-cover" />
            </span>
            <span>
              <span className="block font-display text-[17px] font-bold leading-none">Оплатишка</span>
              <span className="mt-1 block font-body text-[11px] text-[var(--text-muted)]">Партнёрская программа</span>
            </span>
          </div>
          <nav className="mt-2 flex flex-1 flex-col gap-1 px-3">
            {NAV.map((n) => (
              <NavButton key={n.key} item={n} active={screen === n.key} onClick={() => setScreen(n.key)} />
            ))}
          </nav>
          <div className={`mx-3 mt-3 flex items-center gap-2.5 p-3 ${SOFT} shadow-[2px_2px_0_var(--shadow-ink)]`}>
            <span className="flex h-9 w-9 items-center justify-center rounded-full border-[2.5px] border-[var(--shadow-ink)] bg-[var(--color-teal-primary)] font-display text-[13px] font-bold text-[var(--color-paper)]">
              {snap.telegramLinked ? '★' : '?'}
            </span>
            <span className="text-[12px]">
              <span className="block font-body font-semibold">{snap.circle.label}</span>
              <span className="block font-body text-[var(--success)]">● {formatBps(snap.rates.l1Bps)} с оплат</span>
            </span>
          </div>
        </aside>

        {/* ── Main ── */}
        <main className="min-h-screen min-w-0 flex-1 pb-24 lg:pb-0">
          {/* Topbar */}
          <header className="sticky top-0 z-10 flex items-center justify-between border-b-[2.5px] border-[var(--shadow-ink)] bg-[color-mix(in_srgb,var(--bg)_88%,transparent)] px-5 py-4 backdrop-blur">
            <div className="flex items-center gap-2.5">
              {onBack && (
                <button
                  type="button"
                  onClick={onBack}
                  aria-label="Назад к заказам"
                  className="flex h-9 w-9 items-center justify-center rounded-[10px] border-[2.5px] border-[var(--shadow-ink)] bg-[var(--surface)] font-display text-[16px] shadow-[2px_2px_0_var(--shadow-ink)] active:translate-x-[2px] active:translate-y-[2px] active:shadow-none"
                >
                  ←
                </button>
              )}
              <h1 className="font-display text-[22px] font-bold">{title}</h1>
            </div>
            <div className="flex items-center gap-3">
              <span className="hidden items-center gap-1.5 rounded-full border-[2.5px] border-[var(--shadow-ink)] bg-[var(--surface)] px-3 py-1 text-[12px] font-semibold text-[var(--color-skin)] shadow-[2px_2px_0_var(--shadow-ink)] sm:flex">
                🔥 {snap.circle.label}
              </span>
              <ComicButton
                onClick={() => setModalOpen(true)}
                disabled={!snap.canPayout}
                className="!px-4 !py-2 text-[14px]"
              >
                Вывести
              </ComicButton>
            </div>
          </header>

          <div className="mx-auto max-w-[920px] px-5 py-6">
            {screen === 'dashboard' && <Dashboard snap={snap} onScreen={setScreen} />}
            {screen === 'network' && <Network snap={snap} />}
            {screen === 'link' && <LinkScreen snap={snap} onCopied={() => showToast('Ссылка скопирована')} />}
            {screen === 'history' && <History snap={snap} />}
            {screen === 'stats' && <Stats snap={snap} />}
          </div>
        </main>
      </div>

      {/* ── Bottom nav (mobile) ── */}
      <nav className="fixed inset-x-0 bottom-0 z-20 flex items-stretch border-t-[2.5px] border-[var(--shadow-ink)] bg-[var(--surface)] lg:hidden">
        {NAV.map((n) => (
          <button
            key={n.key}
            type="button"
            onClick={() => setScreen(n.key)}
            className={`flex flex-1 flex-col items-center gap-0.5 py-2.5 font-body text-[10px] ${
              screen === n.key ? 'text-[var(--color-teal-light)]' : 'text-[var(--text-muted)]'
            }`}
          >
            <span className="text-[18px]">{n.icon}</span>
            {n.label}
          </button>
        ))}
      </nav>

      {modalOpen && (
        <WithdrawModal
          snap={snap}
          initData={initData}
          onClose={() => setModalOpen(false)}
          onDone={(text) => {
            setModalOpen(false);
            showToast(text);
            void load();
          }}
        />
      )}

      {toast && (
        <div className="fixed bottom-24 left-1/2 z-30 -translate-x-1/2 rounded-[14px] border-[2.5px] border-[var(--shadow-ink)] bg-[var(--surface)] px-5 py-3 font-display text-[14px] font-bold text-[var(--success)] shadow-[var(--shadow-comic)] lg:bottom-6">
          ✓ {toast}
        </div>
      )}
    </div>
  );
}

function NavButton({
  item,
  active,
  onClick,
}: {
  item: { icon: string; label: string };
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 rounded-[12px] border-[2.5px] px-3 py-2.5 text-left font-body text-[14px] transition-transform ${
        active
          ? 'border-[var(--shadow-ink)] bg-[var(--color-teal-primary)] font-bold text-[var(--color-paper)] shadow-[2px_2px_0_var(--shadow-ink)]'
          : 'border-transparent font-medium text-[var(--text-muted)] hover:bg-[var(--surface-2)]'
      }`}
    >
      <span className="w-5 text-center text-[18px]">{item.icon}</span>
      {item.label}
    </button>
  );
}

// ─── DASHBOARD ──────────────────────────────────────────────────────────────

function Dashboard({ snap, onScreen }: { snap: ReferralSnapshot; onScreen: (s: Screen) => void }) {
  const progressPct = Math.min(100, snap.progress.progressBps / 100);
  return (
    <div className="space-y-4">
      {!snap.telegramLinked && <TelegramGate />}

      {/* Hero */}
      <section className={`relative overflow-hidden p-6 ${CARD} !shadow-[6px_6px_0_var(--shadow-ink)]`}>
        <div className="grid gap-5 md:grid-cols-[1fr_168px]">
          <div>
            <span className="inline-flex -rotate-2 items-center gap-2 rounded-[10px] border-[3px] border-[var(--color-teal-light)] px-3 py-1 font-display text-[13px] font-bold uppercase tracking-wide text-[var(--color-teal-light)]">
              ⬤ Статус · {snap.circle.label}
            </span>
            <div className="mt-3 font-display text-[46px] font-bold leading-none">
              {formatUsd(snap.progress.networkTurnoverThisMonthUsdCents)}
            </div>
            <div className="mt-1 mb-4 font-body text-[13px] text-[var(--text-muted)]">Оплаты твоих рефералов · этот месяц</div>

            {snap.circle.nextThresholdUsdCents !== null ? (
              <>
                <div className="mb-1.5 flex justify-between font-body text-[11px] text-[var(--text-muted)]">
                  <span>{formatUsd(0)}</span>
                  <span>
                    {snap.circle.nextLabel} — {formatUsd(snap.circle.nextThresholdUsdCents)}
                  </span>
                </div>
                <div className="h-3.5 overflow-hidden rounded-full border-[2.5px] border-[var(--shadow-ink)] bg-[var(--surface-2)]">
                  <div
                    className="h-full rounded-full transition-[width] duration-1000"
                    style={{
                      width: `${progressPct}%`,
                      background:
                        'repeating-linear-gradient(45deg, var(--color-teal-primary) 0 8px, var(--color-teal-light) 8px 16px)',
                    }}
                  />
                </div>
              </>
            ) : (
              <PaidStampInline label="Топ-партнёр достигнут" />
            )}

            <div className="mt-5 grid gap-3 sm:grid-cols-3">
              <Stat label="Твоя ставка" value={formatBps(snap.rates.l1Bps)} valueColor="var(--acc)">
                {snap.rateLockedForever && (
                  <span className="inline-flex -rotate-3 items-center gap-1 rounded-[6px] border-2 border-[var(--success)] px-1.5 py-px font-display text-[10px] font-bold uppercase text-[var(--success)]">
                    🔒 навсегда
                  </span>
                )}
              </Stat>
              <Stat label="Заработано в этом месяце" value={formatUsd(snap.earnedThisMonthUsdCents)} />
              <Stat label="Баланс к выводу" value={formatUsd(snap.balanceUsdCents)} valueColor="var(--success)">
                <span className="font-body text-[11px] text-[var(--text-muted)]">
                  мин. вывод {formatUsd(snap.minPayoutUsdCents)}
                </span>
              </Stat>
            </div>
          </div>

          {/* Mascot + bubble */}
          <div className="hidden flex-col items-center gap-2 md:flex">
            <div className="relative rounded-[var(--radius-bubble)] rounded-br-[6px] border-[2.5px] border-[var(--shadow-ink)] bg-[var(--bubble-bot)] px-4 py-3 font-body text-[13px] shadow-[2px_2px_0_var(--shadow-ink)]">
              {snap.circle.nextThresholdUsdCents !== null ? (
                <>
                  Отличный темп! Ещё{' '}
                  <strong>{formatUsd(snap.circle.nextThresholdUsdCents - snap.progress.networkTurnoverThisMonthUsdCents)}</strong>{' '}
                  до статуса «{snap.circle.nextLabel}».
                </>
              ) : (
                <>Ты на вершине — ставка {formatBps(snap.rates.l1Bps)}!</>
              )}
            </div>
            <Image
              src={mascotSrc('wave')}
              alt="Оплатишка"
              width={150}
              height={150}
              priority
              className="h-auto w-[150px] object-contain [filter:drop-shadow(4px_6px_0_rgba(0,0,0,0.35))]"
            />
          </div>
        </div>
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        <SprintCard snap={snap} />
        <RateCard snap={snap} />
      </div>

      <SectionHead title="Мои рефералы" action="Подробнее →" onAction={() => onScreen('network')} />
      <NetworkCard snap={snap} compact />

      <SectionHead title="Последние начисления" action="Все →" onAction={() => onScreen('history')} />
      <HistoryList entries={snap.history.slice(0, 4)} empty="Здесь появятся начисления с оплат твоей сети." />
    </div>
  );
}

function Stat({
  label,
  value,
  valueColor,
  children,
}: {
  label: string;
  value: string;
  valueColor?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className={`p-3 ${SOFT} shadow-[2px_2px_0_var(--shadow-ink)]`}>
      <div className="font-body text-[11px] text-[var(--text-muted)]">{label}</div>
      <div className="font-display text-[24px] font-bold leading-none" style={valueColor ? { color: valueColor } : undefined}>
        {value}
      </div>
      {children && <div className="mt-1">{children}</div>}
    </div>
  );
}

function PaidStampInline({ label }: { label: string }) {
  return (
    <span className="inline-flex -rotate-3 items-center rounded-[10px] border-[3px] border-[var(--color-teal-light)] px-3 py-1 font-display text-[13px] font-bold uppercase tracking-wide text-[var(--color-teal-light)]">
      {label}
    </span>
  );
}

function SprintCard({ snap }: { snap: ReferralSnapshot }) {
  const refsPct = Math.min(100, (snap.sprint.newReferralsThisMonth / snap.sprint.newReferralsGoal) * 100);
  const turnoverPct =
    snap.sprint.turnoverBoostThresholdUsdCents > 0
      ? Math.min(100, (snap.sprint.turnoverThisMonthUsdCents / snap.sprint.turnoverBoostThresholdUsdCents) * 100)
      : 0;
  return (
    <section className={`p-5 ${CARD}`}>
      <div className="mb-3.5 font-display text-[14px] font-bold text-[var(--color-skin)]">⚡ Спринт месяца</div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className={`p-3 ${SOFT}`}>
          <div className="font-body text-[11px] text-[var(--text-muted)]">Новых рефералов</div>
          <div className="mb-2 font-display text-[18px] font-bold">
            {snap.sprint.newReferralsThisMonth} / {snap.sprint.newReferralsGoal}
          </div>
          <Bar pct={refsPct} color="var(--color-teal-primary)" />
          <div className="mt-1.5 font-body text-[11px] text-[var(--color-skin)]">
            Ещё {Math.max(0, snap.sprint.newReferralsGoal - snap.sprint.newReferralsThisMonth)} → бонус
          </div>
        </div>
        <div className={`p-3 ${SOFT}`}>
          <div className="font-body text-[11px] text-[var(--text-muted)]">150% плана</div>
          <div className="mb-2 font-display text-[18px] font-bold">
            {formatUsd(snap.sprint.turnoverThisMonthUsdCents)}
          </div>
          <Bar pct={turnoverPct} color="var(--acc2)" />
          <div className="mt-1.5 font-body text-[11px] text-[var(--color-skin)]">+1% буст ставки</div>
        </div>
      </div>
    </section>
  );
}

function RateCard({ snap }: { snap: ReferralSnapshot }) {
  const atTop = snap.circle.nextThresholdUsdCents === null;
  return (
    <section className={`p-5 ${CARD}`}>
      <div className="mb-3.5 font-display text-[14px] font-bold">📊 Твоя ставка</div>
      <div className="flex items-end gap-2.5">
        <div className="font-display text-[52px] font-bold leading-none" style={{ color: 'var(--acc)' }}>
          {formatBps(snap.rates.l1Bps)}
        </div>
        {snap.rateLockedForever && (
          <span className="mb-1 inline-flex -rotate-3 items-center gap-1 rounded-[6px] border-2 border-[var(--success)] px-1.5 py-px font-display text-[10px] font-bold uppercase text-[var(--success)]">
            🔒 навсегда
          </span>
        )}
      </div>
      <p className="mt-2 font-body text-[13px] text-[var(--text-muted)]">
        Столько ты получаешь с <strong className="text-[var(--text)]">каждой оплаты</strong> каждого
        приглашённого тобой человека. Никаких уровней и сетей — только твои личные приглашения.
      </p>
      {!atTop && (
        <div className="mt-3 flex items-center justify-between border-t-2 border-dashed border-[var(--surface-3)] pt-2.5 opacity-60">
          <div className="font-body text-[13px]">🔒 Максимум — статус «Топ-партнёр»</div>
          <div className="font-display text-[24px] font-bold text-[var(--text-muted)]">{formatBps(snap.rates.topL1Bps)}</div>
        </div>
      )}
    </section>
  );
}

// ─── NETWORK ────────────────────────────────────────────────────────────────

function Network({ snap }: { snap: ReferralSnapshot }) {
  return (
    <div className="space-y-4">
      <NetworkCard snap={snap} />
      <SectionHead title="Путь к следующему статусу" />
      <CircleTimeline snap={snap} />
    </div>
  );
}

function NetworkCard({ snap, compact }: { snap: ReferralSnapshot; compact?: boolean }) {
  const n = snap.network;
  const activePct = n.total > 0 ? (n.active / n.total) * 100 : 0;
  return (
    <div className={`p-4 ${CARD}`}>
      <div className="mb-2.5 font-display text-[12px] font-bold uppercase tracking-wide" style={{ color: 'var(--acc)' }}>
        Приглашено тобой · {formatBps(snap.rates.l1Bps)} с их оплат
      </div>
      <div className={`grid gap-3 ${compact ? 'sm:grid-cols-3' : 'sm:grid-cols-2 lg:grid-cols-4'}`}>
        <div className={`p-3 ${SOFT}`}>
          <div className="font-body text-[11px] text-[var(--text-muted)]">Всего рефералов</div>
          <div className="font-display text-[30px] font-bold leading-none" style={{ color: 'var(--acc)' }}>
            {n.total}
          </div>
        </div>
        <div className={`p-3 ${SOFT}`}>
          <div className="font-body text-[11px] text-[var(--text-muted)]">Активных (с покупкой)</div>
          <div className="font-display text-[30px] font-bold leading-none text-[var(--success)]">{n.active}</div>
        </div>
        {!compact && (
          <div className={`p-3 ${SOFT}`}>
            <div className="font-body text-[11px] text-[var(--text-muted)]">Их оплаты за месяц</div>
            <div className="font-display text-[30px] font-bold leading-none">{formatUsd(n.turnoverThisMonthUsdCents)}</div>
          </div>
        )}
        <div className={`p-3 ${SOFT}`}>
          <div className="font-body text-[11px] text-[var(--text-muted)]">Твой доход за месяц</div>
          <div className="font-display text-[30px] font-bold leading-none text-[var(--success)]">
            {formatUsd(n.incomeThisMonthUsdCents)}
          </div>
          <div className="mt-0.5 font-body text-[11px] text-[var(--text-muted)]">
            всего {formatUsd(n.incomeAllTimeUsdCents)}
          </div>
        </div>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full border-2 border-[var(--shadow-ink)] bg-[var(--surface-2)]">
        <div className="h-full rounded-full" style={{ width: `${activePct}%`, background: 'var(--acc)' }} />
      </div>
    </div>
  );
}

function CircleTimeline({ snap }: { snap: ReferralSnapshot }) {
  // Достигнутые статусы (≤ текущего) + следующий как pending. Бонусы/маркетинг —
  // из таблицы статусов на стороне снапшота недоступны детально, показываем суть.
  const items: { n: number; label: string; done: boolean; rate: string; note: string }[] = [];
  for (let c = 1; c <= 3; c++) {
    const done = c <= snap.circle.circle;
    const pending = c === snap.circle.circle + 1;
    if (!done && !pending) continue;
    items.push({
      n: c,
      label:
        c === 1 ? 'Статус 1 · Старт' : c === 2 ? 'Статус 2 · Партнёр' : 'Статус 3 · Топ-партнёр',
      done,
      rate: c === 1 ? '4%' : c === 2 ? '6%' : '7%',
      note: done ? 'зафиксирована навсегда' : 'осталось набрать оборот',
    });
  }
  return (
    <section className={`p-5 ${CARD}`}>
      {items.map((it, i) => (
        <div key={it.n} className="flex gap-3.5">
          <div className="flex flex-col items-center">
            <span
              className="flex h-8 w-8 items-center justify-center rounded-full border-[2.5px] border-[var(--shadow-ink)] font-display text-[14px] font-bold"
              style={{
                background: it.done ? 'color-mix(in srgb, var(--color-teal-light) 24%, transparent)' : 'var(--surface-3)',
                color: it.done ? 'var(--color-teal-light)' : 'var(--text-muted)',
              }}
            >
              {it.done ? '✓' : it.n}
            </span>
            {i < items.length - 1 && <span className="my-1 w-[3px] flex-1 bg-[var(--surface-3)]" />}
          </div>
          <div
            className={`mb-3.5 flex-1 rounded-[14px] border-[2.5px] px-4 py-3 ${
              it.done ? 'border-[var(--shadow-ink)] bg-[var(--surface-2)]' : 'border-dashed border-[var(--shadow-ink)] opacity-65'
            }`}
          >
            <div className="font-display text-[14px] font-bold">{it.label}</div>
            <div className="mb-2 font-body text-[12px] text-[var(--text-muted)]">{it.note}</div>
            <span
              className="inline-flex items-center gap-1 rounded-[8px] border-2 px-2.5 py-0.5 font-display text-[11px] font-bold"
              style={{ color: it.done ? 'var(--color-teal-light)' : 'var(--text-muted)' }}
            >
              {it.done ? '🔒 ' : ''}
              {it.rate} {it.done ? 'навсегда' : ''}
            </span>
          </div>
        </div>
      ))}
    </section>
  );
}

// ─── LINK ───────────────────────────────────────────────────────────────────

function LinkScreen({ snap, onCopied }: { snap: ReferralSnapshot; onCopied: () => void }) {
  // Единственный канал приглашения — Telegram deep-link: реферал закрепляется,
  // когда друг запускает бота по ссылке (веб-захвата больше нет).
  const link = snap.telegramLink ?? '';
  const shareUrl = link
    ? `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(
        'Оплачиваю иностранные подписки в рублях через Оплатишку — попробуй!',
      )}`
    : '';
  const copy = useCallback(() => {
    if (!link) return;
    void navigator.clipboard?.writeText(link).then(onCopied).catch(() => onCopied());
  }, [link, onCopied]);
  return (
    <div className="space-y-4">
      <section className={`relative overflow-hidden p-7 text-center ${CARD} !shadow-[6px_6px_0_var(--shadow-ink)]`}>
        <Image
          src={mascotSrc('presenting')}
          alt="Оплатишка"
          width={96}
          height={96}
          className="mx-auto mb-1.5 h-auto w-24 object-contain [filter:drop-shadow(3px_4px_0_rgba(0,0,0,0.3))]"
        />
        <div className="font-display text-[26px] font-bold">Твоя ссылка-приглашение</div>
        <div className="mb-5 font-body text-[13px] text-[var(--text-muted)]">
          Работает через Telegram: друг открывает бота по ссылке — и закрепляется за тобой
        </div>
        <div className={`mx-auto mb-4 flex w-full max-w-[460px] items-center justify-between gap-2.5 p-2.5 pl-4 ${SOFT} shadow-[2px_2px_0_var(--shadow-ink)]`}>
          <span className="min-w-0 flex-1 truncate font-display text-[15px] font-bold text-[var(--color-teal-light)]">
            {link || 'ссылка готовится…'}
          </span>
          <ComicButton onClick={copy} disabled={!link} className="shrink-0 !px-3.5 !py-2 text-[13px]">
            Скопировать
          </ComicButton>
        </div>
        {shareUrl && (
          <a
            href={shareUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 font-body text-[13px] text-[var(--link)] underline-offset-2 hover:underline"
          >
            ✈️ Поделиться в Telegram
          </a>
        )}
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        <section className={`p-5 ${CARD}`}>
          <div className="mb-3.5 font-display text-[14px] font-bold">💡 Как это работает</div>
          {[
            { n: '1', t: 'Отправь другу свою ссылку в Telegram' },
            { n: '2', t: 'Друг открывает бота и оплачивает любую подписку' },
            {
              n: '3',
              t: `Ты получаешь ${formatBps(snap.rates.l1Bps)} с каждой его оплаты — всегда`,
            },
          ].map((r) => (
            <div key={r.n} className="flex items-center gap-3 border-b-2 border-dashed border-[var(--surface-3)] py-2.5 last:border-0">
              <span
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-[2.5px] border-[var(--shadow-ink)] font-display text-[14px] font-bold"
                style={{ background: 'color-mix(in srgb, var(--acc) 22%, transparent)', color: 'var(--acc)' }}
              >
                {r.n}
              </span>
              <span className="font-body text-[13px]">{r.t}</span>
            </div>
          ))}
        </section>
        <section className={`p-5 ${CARD}`}>
          <div className="mb-3.5 font-display text-[14px] font-bold">🏆 Твой статус</div>
          <div className={`mb-2.5 p-3 ${SOFT}`}>
            <div className="font-body text-[11px] text-[var(--text-muted)]">Текущий статус</div>
            <div className="font-display text-[22px] font-bold">{snap.circle.label}</div>
          </div>
          <div className={`p-3 ${SOFT}`}>
            <div className="font-body text-[11px] text-[var(--text-muted)]">Заработано всего</div>
            <div className="font-display text-[22px] font-bold text-[var(--success)]">{formatUsd(snap.earnedTotalUsdCents)}</div>
          </div>
        </section>
      </div>
    </div>
  );
}

// ─── HISTORY ────────────────────────────────────────────────────────────────

function History({ snap }: { snap: ReferralSnapshot }) {
  return (
    <div className="space-y-3">
      <HistoryList entries={snap.history} empty="Пока пусто. Начисления появятся после первых оплат в твоей сети." />
    </div>
  );
}

function HistoryList({ entries, empty }: { entries: ReferralHistoryEntry[]; empty: string }) {
  if (entries.length === 0) {
    return <p className="font-body text-[13px] text-[var(--text-muted)]">{empty}</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      {entries.map((e, i) => (
        <div
          key={`${e.at}-${i}`}
          className={`flex items-center gap-3 px-3.5 py-2.5 ${SOFT} shadow-[2px_2px_0_var(--shadow-ink)] ${
            e.reversed ? 'opacity-55' : ''
          }`}
        >
          <span
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-[2.5px] border-[var(--shadow-ink)] font-display text-[13px] font-bold"
            style={{
              background:
                e.kind === 'payout'
                  ? 'var(--surface-3)'
                  : e.kind === 'commission'
                    ? 'color-mix(in srgb, var(--acc) 22%, transparent)'
                    : 'color-mix(in srgb, var(--success) 22%, transparent)',
              color:
                e.kind === 'payout'
                  ? 'var(--text-muted)'
                  : e.kind === 'commission'
                    ? 'var(--acc)'
                    : 'var(--success)',
            }}
          >
            {e.kind === 'payout' ? '↑' : e.kind === 'commission' ? initials(e.title) : '🎁'}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate font-body text-[13px] font-semibold">{e.title}</div>
            <div className="truncate font-body text-[11px] text-[var(--text-muted)]">
              {e.subtitle || e.statusLabel}
            </div>
          </div>
          <div className="text-right">
            <div
              className="font-display text-[15px] font-bold"
              style={{ color: e.amountUsdCents < 0 ? 'var(--text-muted)' : 'var(--success)' }}
            >
              {e.amountUsdCents >= 0 ? '+' : ''}
              {formatUsd(e.amountUsdCents)}
            </div>
            <div className="font-body text-[11px] text-[var(--text-muted)]">{formatLedgerDate(e.at)}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '★';
}

// ─── STATS ──────────────────────────────────────────────────────────────────

function Stats({ snap }: { snap: ReferralSnapshot }) {
  const maxMonthly = Math.max(1, ...snap.monthlyIncome.map((m) => m.usdCents));
  const activePct = snap.network.total > 0 ? (snap.network.active / snap.network.total) * 100 : 0;
  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <section className={`p-5 ${CARD}`}>
          <div className="mb-1 font-display text-[14px] font-bold">💰 Общий доход</div>
          <div className="font-display text-[44px] font-bold leading-none text-[var(--success)]">
            {formatUsd(snap.earnedTotalUsdCents)}
          </div>
          <div className="mt-1 font-body text-[12px] text-[var(--text-muted)]">за всё время</div>
          <div className="mt-4 flex h-[92px] items-end gap-2">
            {snap.monthlyIncome.map((m, i) => (
              <div key={m.month} className="flex flex-1 flex-col items-center gap-1.5">
                <span className="font-display text-[11px] font-bold text-[var(--text-muted)]">
                  {m.usdCents > 0 ? formatUsd(m.usdCents) : ''}
                </span>
                <div
                  className="w-full rounded-t-[8px] border-[2.5px] border-[var(--shadow-ink)]"
                  style={{
                    height: `${Math.max(6, (m.usdCents / maxMonthly) * 64)}px`,
                    background:
                      i === snap.monthlyIncome.length - 1 ? 'var(--success)' : 'color-mix(in srgb, var(--success) 45%, transparent)',
                  }}
                />
                <span className="font-body text-[10px] text-[var(--text-muted)]">{formatMonthShort(m.month)}</span>
              </div>
            ))}
          </div>
        </section>

        <section className={`p-5 ${CARD}`}>
          <div className="mb-1 font-display text-[14px] font-bold">🌱 Мои рефералы</div>
          <div className="font-display text-[44px] font-bold leading-none" style={{ color: 'var(--acc)' }}>
            {snap.network.total}
          </div>
          <div className="mt-1 font-body text-[12px] text-[var(--text-muted)]">приглашено всего</div>
          <div className="mt-5 space-y-3">
            <div className="flex items-center gap-3">
              <span className="w-20 font-body text-[12px] text-[var(--text-muted)]">Активных</span>
              <div className="h-3 flex-1 overflow-hidden rounded-full border-2 border-[var(--shadow-ink)] bg-[var(--surface-2)]">
                <div className="h-full rounded-full" style={{ width: `${activePct}%`, background: 'var(--acc)' }} />
              </div>
              <span className="w-10 text-right font-display text-[13px] font-bold">{snap.network.active}</span>
            </div>
            <div className="flex items-center justify-between border-t-2 border-dashed border-[var(--surface-3)] pt-3">
              <span className="font-body text-[12px] text-[var(--text-muted)]">Оплаты рефералов за месяц</span>
              <span className="font-display text-[15px] font-bold">{formatUsd(snap.network.turnoverThisMonthUsdCents)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="font-body text-[12px] text-[var(--text-muted)]">Твой доход с них за всё время</span>
              <span className="font-display text-[15px] font-bold text-[var(--success)]">
                {formatUsd(snap.network.incomeAllTimeUsdCents)}
              </span>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

// ─── shared ─────────────────────────────────────────────────────────────────

function Bar({ pct, color }: { pct: number; color: string }) {
  return (
    <div className="h-2 overflow-hidden rounded-full border-2 border-[var(--shadow-ink)] bg-[var(--surface-3)]">
      <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}

function SectionHead({ title, action, onAction }: { title: string; action?: string; onAction?: () => void }) {
  return (
    <div className="mt-1 flex items-center justify-between">
      <h2 className="font-display text-[16px] font-bold">{title}</h2>
      {action && onAction && (
        <button type="button" onClick={onAction} className="font-body text-[13px] font-medium text-[var(--link)] hover:underline">
          {action}
        </button>
      )}
    </div>
  );
}

function TelegramGate() {
  return (
    <div className="flex items-center gap-3.5 rounded-[var(--radius-card)] border-[2.5px] border-dashed border-[var(--color-stamp)] bg-[var(--surface)] px-4 py-3.5">
      <span className="text-[26px]">🔗</span>
      <div className="flex-1 font-body text-[13px]">
        <strong className="font-display">Привяжи Telegram</strong> — чтобы выводить заработок. Реферальная
        ссылка уже работает, но баланс выводится только привязанному аккаунту.
      </div>
      <Link href="/" className="shrink-0 font-body text-[13px] font-semibold text-[var(--link)] hover:underline">
        Привязать →
      </Link>
    </div>
  );
}

function WithdrawModal({
  snap,
  initData,
  onClose,
  onDone,
}: {
  snap: ReferralSnapshot;
  initData?: string;
  onClose: () => void;
  onDone: (text: string) => void;
}) {
  const [amount, setAmount] = useState(String(Math.floor(snap.balanceUsdCents / 100)));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = useCallback(async () => {
    const dollars = Number(amount);
    if (!Number.isFinite(dollars) || dollars <= 0) {
      setErr('Введи сумму больше нуля.');
      return;
    }
    setBusy(true);
    setErr(null);
    const res = await requestPayout(Math.round(dollars * 100), initData);
    setBusy(false);
    if (res.ok) {
      onDone(`Заявка на вывод ${formatUsd(res.amountUsdCents)} отправлена`);
    } else {
      setErr(errorText(res));
    }
  }, [amount, initData, onDone]);

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-5" onClick={onClose}>
      <div
        className={`w-[400px] max-w-full p-6 ${CARD} !shadow-[6px_6px_0_var(--shadow-ink)]`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="font-display text-[22px] font-bold">Вывести деньги</div>
        <div className="mb-4 font-body text-[13px] text-[var(--text-muted)]">
          Средства поступят в течение 1–3 рабочих дней
        </div>
        <div className={`mb-4 p-3.5 ${SOFT}`}>
          <div className="font-body text-[11px] text-[var(--text-muted)]">Доступно к выводу</div>
          <div className="font-display text-[30px] font-bold text-[var(--success)]">{formatUsd(snap.balanceUsdCents)}</div>
        </div>
        <label className="mb-1.5 block font-body text-[12px] font-medium text-[var(--text-muted)]">
          Сумма в долларах (минимум {formatUsd(snap.minPayoutUsdCents)})
        </label>
        <input
          type="number"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="mb-3 w-full rounded-[12px] border-[2.5px] border-[var(--shadow-ink)] bg-[var(--surface-2)] px-3.5 py-2.5 font-display text-[18px] font-bold text-[var(--text)] outline-none focus:border-[var(--color-teal-primary)]"
        />
        {err && <div className="mb-3 font-body text-[12px] text-[var(--color-stamp)]">{err}</div>}
        <div className="flex gap-2.5">
          <ComicButton variant="surface" onClick={onClose} className="flex-1 !py-2.5 text-[14px]">
            Отмена
          </ComicButton>
          <ComicButton onClick={submit} disabled={busy} className="flex-[1.4] !py-2.5 text-[14px]">
            {busy ? 'Отправляю…' : 'Вывести'}
          </ComicButton>
        </div>
      </div>
    </div>
  );
}

function errorText(res: { error: string; minPayoutUsdCents?: number; balanceUsdCents?: number }): string {
  switch (res.error) {
    case 'telegram_link_required':
      return 'Сначала привяжи Telegram — вывод доступен только привязанному аккаунту.';
    case 'suspended':
      return 'Выплаты временно заморожены. Напиши в поддержку.';
    case 'below_minimum':
      return `Минимальная сумма вывода — ${formatUsd(res.minPayoutUsdCents ?? 1000)}.`;
    case 'insufficient_balance':
      return `Недостаточно средств. Доступно ${formatUsd(res.balanceUsdCents ?? 0)}.`;
    case 'invalid_amount':
      return 'Введи корректную сумму.';
    case 'disabled':
      return 'Программа пока недоступна.';
    default:
      return 'Не удалось отправить заявку. Попробуй ещё раз.';
  }
}

function Centered({ title, text, onBack }: { title?: string; text: string; onBack?: () => void }) {
  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center gap-3 p-6 text-center">
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          aria-label="Назад к заказам"
          className="absolute left-4 top-4 flex h-9 w-9 items-center justify-center rounded-[10px] border-[2.5px] border-[var(--shadow-ink)] bg-[var(--surface)] font-display text-[16px] shadow-[2px_2px_0_var(--shadow-ink)] active:translate-x-[2px] active:translate-y-[2px] active:shadow-none"
        >
          ←
        </button>
      )}
      <Image
        src={mascotSrc('idle')}
        alt="Оплатишка"
        width={96}
        height={96}
        className="mb-2 h-auto w-24 object-contain [filter:drop-shadow(3px_4px_0_rgba(0,0,0,0.3))]"
      />
      {title && <h1 className="font-display text-[22px] font-bold text-[var(--text)]">{title}</h1>}
      <p className="max-w-sm font-body text-[14px] text-[var(--text-muted)]">{text}</p>
    </div>
  );
}
