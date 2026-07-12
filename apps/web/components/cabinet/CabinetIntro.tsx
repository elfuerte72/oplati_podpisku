'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { ComicButton } from '@/components/comic/ComicButton';
import { PaidStamp } from '@/components/comic/PaidStamp';
import { formatRub } from '@/components/comic/format';
import { IconArrowLeft, IconArrowRight, IconCheck } from '@/components/comic/icons';
import { Mascot, type MascotPose } from '@/components/chat/Mascot';
import { ServiceLogo } from '@/components/chat/ServiceLogos';
import { sortCatalog, type CatalogService } from '@/lib/catalog/build';
import { fetchWithTimeout } from '@/lib/http';

/**
 * Онбординг Telegram Mini App при первом входе в кабинет.
 *
 * Первый кадр — приветствие (крупный маскот + понятный текст «что это»), затем
 * три шага реального флоу «выбрать → карта → оплатить на сайте» с наглядными
 * CSS-макетами экранов (не скриншотами — макеты не устаревают). Кабинет
 * кнопочный (не чат, как на сайте), поэтому веб-интро сюда не подходит.
 *
 * Показ — один раз (флаг в CabinetClient), «Пропустить» доступен всегда; повтор —
 * из шапки кабинета. Привязки Telegram тут нет: в Mini App клиент уже авторизован
 * через initData.
 */

type IntroHaptic = (kind: 'tick' | 'success') => void;

type StepFrame = { step: string; title: string; text: string; pose: MascotPose };

/** Кадр 0 — знакомство: крупный маскот + короткий понятный ответ «что это». */
const WELCOME: { pose: MascotPose; title: string; text: string } = {
  pose: 'wave',
  title: 'Привет! Я Оплатишка',
  text: 'Помогу оплатить зарубежные подписки — ChatGPT, Claude, Midjourney и другие — обычными рублями. Покажу за 20 секунд, как всё работает.',
};

const STEPS = [
  {
    step: 'Шаг 1',
    title: 'Выбираешь сервис и платишь рублями',
    text: 'Открываешь «Выбрать сервис», жмёшь нужный и платишь картой или через СБП — в рублях, по текущему курсу.',
    pose: 'presenting',
  },
  {
    step: 'Шаг 2',
    title: 'Получаешь виртуальную карту',
    text: 'Я выпущу карту и пополню её на сумму подписки — номер, срок и CVC придут сюда и в Telegram. Выпуск карты — разовые +$4 в первом заказе, дальше платишь только за подписку.',
    pose: 'attentive',
  },
  {
    step: 'Шаг 3',
    title: 'Оплачиваешь подписку на сайте',
    text: 'Вводишь данные карты на сайте сервиса — и подписка твоя. Совет: включи VPN с локацией США, чтобы не переплатить.',
    pose: 'celebrate',
  },
] as const satisfies readonly StepFrame[];

/** Подписи точек прогресса (первая — знакомство, дальше шаги). */
const DOT_LABELS = ['Знакомство', ...STEPS.map((s) => s.step)];
const FRAME_COUNT = DOT_LABELS.length; // знакомство + шаги
const LAST = FRAME_COUNT - 1;

/** Порог свайпа в px, за которым засчитываем листание кадра. */
const SWIPE_THRESHOLD = 44;

/** Пример сервиса в макете шага 1 (логотип + подпись). */
type IntroExample = { slug: string; name: string };
/** Мини-«чек» в макете шага 1 (сервис + оценка к оплате). */
type IntroCheck = { name: string; priceLabel: string };

/**
 * Статичный фолбэк на случай недоступного каталога — актуальные слаги, чтобы
 * логотипы точно резолвились. Реальные примеры и цену подтягиваем из
 * `/api/catalog` при показе (см. эффект), чтобы онбординг не устаревал.
 */
const FALLBACK_EXAMPLES: IntroExample[] = [
  { slug: 'chatgpt-plus', name: 'ChatGPT' },
  { slug: 'claude-pro', name: 'Claude' },
  { slug: 'midjourney-basic', name: 'Midjourney' },
];
const FALLBACK_CHECK: IntroCheck = { name: 'ChatGPT', priceLabel: '≈ 1 490 ₽' };

export function CabinetIntro({
  onClose,
  haptic,
}: {
  onClose: () => void;
  haptic?: IntroHaptic;
}) {
  const [frame, setFrame] = useState(0);
  const touchStartX = useRef<number | null>(null);

  // Примеры сервисов для макета шага 1 — из реального каталога (с фолбэком),
  // чтобы онбординг не показывал сервисы, которых уже нет.
  const [examples, setExamples] = useState<IntroExample[]>(FALLBACK_EXAMPLES);
  const [check, setCheck] = useState<IntroCheck>(FALLBACK_CHECK);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchWithTimeout('/api/catalog');
        const data = (await res.json()) as { ok?: boolean; services?: CatalogService[] };
        if (cancelled || !data.ok || !data.services?.length) return;
        const withTiers = sortCatalog(data.services).filter(
          (s) => !s.customAmount && s.tiers.length > 0,
        );
        const top = withTiers.slice(0, 3);
        const first = top[0];
        if (!first) return;
        setExamples(top.map((s) => ({ slug: s.slug, name: s.name })));
        const cheapest = first.tiers.reduce((a, b) => (b.totalKopecks < a.totalKopecks ? b : a));
        setCheck({ name: first.name, priceLabel: `≈ ${formatRub(cheapest.totalKopecks)}` });
      } catch {
        // каталог недоступен — остаётся статичный фолбэк, интро не ломаем
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const go = useCallback(
    (next: number) => {
      const clamped = Math.max(0, Math.min(LAST, next));
      setFrame((prev) => {
        if (clamped !== prev) haptic?.('tick');
        return clamped;
      });
    },
    [haptic],
  );

  const finish = useCallback(() => {
    haptic?.('success');
    onClose();
  }, [haptic, onClose]);

  const advance = useCallback(() => {
    if (frame >= LAST) finish();
    else go(frame + 1);
  }, [frame, finish, go]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight') advance();
      else if (e.key === 'ArrowLeft') go(frame - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, advance, go, frame]);

  const isWelcome = frame === 0;
  // Всегда валидный шаг (для кадра-знакомства просто не рендерится) — упрощает типы.
  const step = STEPS[frame - 1] ?? STEPS[0];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Как работает Оплатишка"
      className="halftone fixed inset-0 z-[70] flex flex-col overflow-y-auto bg-[var(--bg)]"
      onTouchStart={(e) => {
        touchStartX.current = e.touches[0]?.clientX ?? null;
      }}
      onTouchEnd={(e) => {
        const start = touchStartX.current;
        touchStartX.current = null;
        if (start === null) return;
        const dx = (e.changedTouches[0]?.clientX ?? start) - start;
        if (dx <= -SWIPE_THRESHOLD) advance();
        else if (dx >= SWIPE_THRESHOLD) go(frame - 1);
      }}
    >
      <div className="mx-auto flex min-h-full w-full max-w-md flex-col px-5 pb-6 pt-4">
        {/* Верх: точки прогресса + «Пропустить» */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5" role="tablist" aria-label="Шаги">
            {DOT_LABELS.map((label, i) => (
              <button
                key={label}
                type="button"
                role="tab"
                aria-selected={i === frame}
                aria-label={label}
                onClick={() => go(i)}
                className={[
                  'h-2 rounded-full border-2 border-[var(--shadow-ink)] transition-[width,background-color] duration-200',
                  i === frame ? 'w-6 bg-[var(--accent)]' : 'w-2 bg-[var(--surface-2)]',
                ].join(' ')}
              />
            ))}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="font-body text-sm text-[var(--text-muted)] underline-offset-2 active:opacity-70"
          >
            Пропустить
          </button>
        </div>

        {isWelcome ? (
          /* ── Кадр 0: знакомство — крупный маскот + понятный текст «что это» ── */
          <div
            key="welcome"
            className="flex flex-1 flex-col items-center justify-center gap-5 text-center motion-safe:animate-[intro-rise_400ms_var(--ease-pop)_both]"
          >
            <Mascot pose={WELCOME.pose} size={152} />
            <h2 className="font-display text-[28px] font-bold leading-tight text-[var(--text)]">
              {WELCOME.title}
            </h2>
            <p className="max-w-sm font-body text-[17px] leading-relaxed text-[var(--text)]">
              {WELCOME.text}
            </p>
          </div>
        ) : (
          /* ── Кадры 1-3: описание сверху крупно, наглядный пример ниже ── */
          <>
            <div
              key={`copy-${frame}`}
              className="mt-6 flex items-center gap-3 motion-safe:animate-[intro-rise_360ms_var(--ease-pop)_both]"
            >
              <Mascot pose={step.pose} size={88} />
              <div className="min-w-0">
                <span className="inline-block rounded-full border-2 border-[var(--shadow-ink)] bg-[var(--color-teal-primary)] px-2.5 py-0.5 font-display text-xs font-bold text-[var(--color-paper)]">
                  {step.step}
                </span>
                <h2 className="mt-1.5 font-display text-[22px] font-bold leading-tight text-[var(--text)]">
                  {step.title}
                </h2>
              </div>
            </div>

            <p
              key={`text-${frame}`}
              className="mt-3 font-body text-[16px] leading-relaxed text-[var(--text)] motion-safe:animate-[intro-rise_360ms_var(--ease-pop)_40ms_both]"
            >
              {step.text}
            </p>

            {/* Наглядный пример — макет экрана (иллюстрация, не живой список:
                реальный выбор откроется по «Выбрать сервис» в кабинете). Размер
                ограничен, чтобы не перетягивать внимание с описания. */}
            <div
              key={`visual-${frame}`}
              className="flex flex-1 flex-col items-center justify-center py-5 motion-safe:animate-[intro-rise_360ms_var(--ease-pop)_80ms_both]"
            >
              <div className="w-full max-w-[300px]">
                <IntroVisual mockIndex={frame - 1} examples={examples} check={check} />
              </div>
              <p className="mt-3 font-body text-xs text-[var(--text-muted)]">Пример для наглядности</p>
            </div>
          </>
        )}

        {/* Навигация — закреплена внизу (удобно большому пальцу). */}
        <div className="mt-2 flex items-center gap-3">
          {frame > 0 && (
            <button
              type="button"
              onClick={() => go(frame - 1)}
              aria-label="Назад"
              className="inline-flex items-center gap-1 font-display text-sm font-bold text-[var(--link)] active:opacity-70"
            >
              <IconArrowLeft size={16} />
              Назад
            </button>
          )}
          <ComicButton onClick={advance} className="ml-auto inline-flex items-center gap-1.5">
            {frame >= LAST ? (
              <>
                <IconCheck size={18} />
                Понятно, начать!
              </>
            ) : (
              <>
                {isWelcome ? 'Поехали' : 'Дальше'}
                <IconArrowRight size={18} />
              </>
            )}
          </ComicButton>
        </div>
      </div>
    </div>
  );
}

/** Мини-макеты экранов кабинета — «наглядные примеры» для каждого шага. */
function IntroVisual({
  mockIndex,
  examples,
  check,
}: {
  mockIndex: number;
  examples: IntroExample[];
  check: IntroCheck;
}) {
  if (mockIndex === 0) return <ChooseAndPayMock examples={examples} check={check} />;
  if (mockIndex === 1) return <CardMock />;
  return <PayOnSiteMock />;
}

const mockPlate =
  'grid h-9 w-9 shrink-0 place-items-center rounded-xl border-2 border-[var(--shadow-ink)] bg-[var(--color-paper)]';

/** Шаг 1: сетка сервисов (первый выбран) → мини-чек с суммой и кнопкой «Оплатить». */
function ChooseAndPayMock({ examples, check }: { examples: IntroExample[]; check: IntroCheck }) {
  const tiles = examples.slice(0, 3);
  return (
    <div className="w-full space-y-2.5">
      <div className="grid grid-cols-3 gap-2">
        {tiles.map((t, i) => (
          <div
            key={t.slug}
            className={[
              'flex flex-col items-center gap-1.5 rounded-[var(--radius-card)] border-[2.5px] px-1.5 py-2.5 shadow-[var(--shadow-comic)]',
              i === 0
                ? 'border-[var(--accent)] bg-[var(--surface)] ring-2 ring-[var(--accent)]'
                : 'border-[var(--shadow-ink)] bg-[var(--surface)]',
            ].join(' ')}
          >
            <span className={mockPlate}>
              <ServiceLogo slug={t.slug} name={t.name} size={20} />
            </span>
            <span className="max-w-full truncate text-center font-body text-[11px] font-semibold text-[var(--text)]">
              {t.name}
            </span>
          </div>
        ))}
      </div>

      {/* мини-«чек» выбранного тарифа */}
      <div className="rounded-[var(--radius-card)] border-[2.5px] border-[var(--shadow-ink)] bg-[var(--surface)] p-3.5 shadow-[var(--shadow-comic)]">
        <div className="flex items-center justify-between gap-2">
          <span className="min-w-0 truncate font-body text-sm font-semibold text-[var(--text)]">
            {check.name}
          </span>
          <span className="shrink-0 font-display text-lg font-bold text-[var(--accent)]">
            {check.priceLabel}
          </span>
        </div>
        <div className="my-2.5 border-t-2 border-dashed border-[var(--shadow-ink)]" />
        <div className="flex items-center justify-center rounded-[12px] border-[2.5px] border-[var(--shadow-ink)] bg-[var(--color-teal-primary)] py-2 font-display text-sm font-bold text-[var(--color-paper)] shadow-[2px_2px_0_var(--shadow-ink)]">
          Оплатить
        </div>
      </div>
    </div>
  );
}

/** Шаг 2: виртуальная карта — повторяет вид CardHero (teal-градиент, чип, PAN). */
function CardMock() {
  return (
    <div
      className="halftone relative flex aspect-[1.6/1] w-full flex-col justify-between overflow-hidden rounded-[var(--radius-card)] border-[2.5px] border-[var(--shadow-ink)] p-4 text-[var(--color-paper)] shadow-[var(--shadow-comic-lg)]"
      style={{ background: 'linear-gradient(135deg, var(--color-teal-deep), var(--color-teal-primary))' }}
    >
      <div className="flex items-start justify-between">
        <span className="font-display text-base font-bold tracking-tight">Оплатишка</span>
        <span className="inline-flex items-center gap-1.5 rounded-full border-2 border-[var(--shadow-ink)] bg-[var(--color-paper)] px-2 py-0.5 font-display text-[10px] font-bold text-[var(--color-ink)]">
          <span className="h-2 w-2 rounded-full" style={{ background: 'var(--success)' }} />
          Активна
        </span>
      </div>

      <span className="h-6 w-9 rounded-[6px] border-2 border-[var(--shadow-ink)] bg-[var(--color-skin)]" />

      <p className="font-display text-lg font-bold tracking-[0.14em]">•••• •••• •••• 4242</p>

      <div className="flex items-end justify-between gap-3">
        <span className="text-left">
          <span className="block font-body text-[9px] uppercase tracking-wider opacity-80">Срок</span>
          <span className="font-display text-sm font-bold">08 / 29</span>
        </span>
        <span className="text-left">
          <span className="block font-body text-[9px] uppercase tracking-wider opacity-80">CVC</span>
          <span className="font-display text-sm font-bold">•••</span>
        </span>
        <span className="font-body text-[10px] uppercase tracking-wider opacity-80">Виртуальная карта</span>
      </div>
    </div>
  );
}

/** Шаг 3: «оплата на сайте сервиса» — форма с картой + штамп «ОПЛАЧЕНО». */
function PayOnSiteMock() {
  return (
    <div className="relative w-full">
      <div className="rounded-[var(--radius-card)] border-[2.5px] border-[var(--shadow-ink)] bg-[var(--surface)] shadow-[var(--shadow-comic-lg)]">
        {/* «шапка браузера» */}
        <div className="flex items-center gap-1.5 rounded-t-[var(--radius-card)] border-b-2 border-[var(--shadow-ink)] bg-[var(--surface-2)] px-3 py-2">
          <span className="h-2.5 w-2.5 rounded-full border border-[var(--shadow-ink)] bg-[var(--color-stamp)]" />
          <span className="h-2.5 w-2.5 rounded-full border border-[var(--shadow-ink)] bg-[var(--color-skin)]" />
          <span className="h-2.5 w-2.5 rounded-full border border-[var(--shadow-ink)] bg-[var(--success)]" />
          <span className="ml-2 font-body text-[11px] text-[var(--text-muted)]">сайт сервиса</span>
        </div>

        <div className="space-y-2.5 p-4">
          <p className="font-display text-sm font-bold text-[var(--text)]">Оплата подписки</p>
          <div className="rounded-[12px] border-2 border-[var(--shadow-ink)] bg-[var(--bg)] px-3 py-2 font-display text-sm font-bold tracking-[0.1em] text-[var(--text)]">
            4242 4242 4242 4242
          </div>
          <div className="flex gap-2.5">
            <div className="flex-1 rounded-[12px] border-2 border-[var(--shadow-ink)] bg-[var(--bg)] px-3 py-2 font-display text-sm font-bold text-[var(--text)]">
              08 / 29
            </div>
            <div className="flex-1 rounded-[12px] border-2 border-[var(--shadow-ink)] bg-[var(--bg)] px-3 py-2 font-display text-sm font-bold text-[var(--text)]">
              •••
            </div>
          </div>
        </div>
      </div>

      {/* штамп «ОПЛАЧЕНО» поверх формы */}
      <div className="pointer-events-none absolute -bottom-3 right-2">
        <PaidStamp />
      </div>
    </div>
  );
}
