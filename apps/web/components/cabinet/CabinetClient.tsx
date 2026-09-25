'use client';

import {
  memo,
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import { ComicButton } from '@/components/comic/ComicButton';
import { formatUsd } from '@/components/comic/format';
import { ServiceInstructions } from '@/components/catalog/ServiceInstructions';
import { PartnerCabinet } from '@/components/partner/PartnerCabinet';
import { track } from '@/lib/analytics/client';
import {
  POLL_MAX_MS,
  afterPaymentOutcome,
  isDuplicateReturn,
  nextPollDelayMs,
  pollTargetOrderId,
  shouldPoll,
  shouldWatchIssuing,
} from '@/lib/cabinet/after-payment';
import { applyCardLive, shouldRefreshCardLive } from '@/lib/cabinet/card-live';
import { selectCardTabState } from '@/lib/cabinet/card-tab-state';
import { siteHostFromUrl } from '@/lib/cabinet/path-steps';
import type { PaymentIssueType, PaymentProblemType } from '@/lib/cabinet/payment-issues';
import { selectPendingPaymentOrders } from '@/lib/cabinet/pending-orders';
import {
  CABINET_TABS,
  SETTLE_MS,
  dragOffset,
  lockAxis,
  releaseVelocity,
  resolveSwipe,
  settleDurationMs,
  startsInEdgeGuard,
  type CabinetTab,
  type SwipeSample,
} from '@/lib/cabinet/tab-swipe';
import type { CatalogService } from '@/lib/catalog/build';

import { CabinetIntro } from './CabinetIntro';
import { CabinetLoader } from './CabinetLoader';
import { CardDetailsSheet } from './CardDetailsSheet';
import { CardTab } from './CardTab';
import { ServicePicker, formatTierPeriod, prefetchCatalog, useCatalog, type OrderHint } from './CatalogView';
import { OrderDetailView, type DetailActionMessage } from './OrderDetailView';
import { PayTab } from './PayTab';
import { PaymentIssueForm, paymentIssueSentText } from './PaymentIssueForm';
import { ProfileTab } from './ProfileTab';
import { ProfileView } from './ProfileView';
import { Sheet } from './Sheet';
import { TabBar } from './TabBar';
import {
  checkPromo,
  doCancelOrder,
  doMarkSubscriptionPaid,
  doOpenSupport,
  doPay,
  doReportPaymentIssue,
  doReportPaymentProblem,
  doUpdateContacts,
  fetchCardLive,
  fetchOrderDetail,
  fetchSnapshot,
  type CancelOrderResult,
  type OrderDetail,
  type PromoCheckResult,
  type Snapshot,
} from './cabinet-api';
import { errorTextFor } from './error-text';
import {
  loadTelegramWebApp,
  readLaunchInitData,
  tolerateTelegram,
  type TelegramMainButton,
  type TelegramWebApp,
} from './telegram';

/**
 * Оболочка личного кабинета — Telegram Mini App на трёх вкладках (трек
 * miniapp-tabs, спека `.scratch/miniapp-tabs/spec.md`).
 *
 * Вкладки «Оплата», «Карта», «Профиль» лежат в ряд и переключаются нижней
 * панелью или пальцем; всё второстепенное — заказ, реквизиты, партнёрка,
 * правка контактов — открывается листом поверх вкладки. Переделка — это
 * оболочка, а не логика: экраны-компоненты и контракт `POST /api/cabinet`
 * прежние, денежные гейты живут на сервере.
 */

type Phase = 'loading' | 'no-telegram' | 'error' | 'ready';

type SheetState =
  | { kind: 'service'; service: CatalogService }
  | { kind: 'order'; orderId: string; hint: OrderHint | null }
  | { kind: 'partner' }
  | { kind: 'contacts' }
  | { kind: 'card-details'; cardId: string }
  | { kind: 'card-issue'; orderId: string };

/**
 * Ключ «видел онбординг». Версия в имени сменена вместе с переделкой на
 * вкладки (тикет 11): вернувшиеся клиенты один раз увидят новый порядок кадров
 * — прежний объяснял экран, которого больше нет.
 */
const CABINET_INTRO_KEY = 'oplatishka_cabinet_intro_seen_v2';

/** Насколько должно ужаться окно, чтобы считать это клавиатурой. */
const KEYBOARD_MIN_PX = 120;

/** Сколько висит плашка уведомления оболочки. */
const NOTICE_MS = 6000;

const noopSubscribe = () => () => {};

/**
 * «Видел ли клиент онбординг кабинета» как external store (localStorage): на
 * сервере считаем «видел» (не рендерим — нет hydration mismatch), на клиенте
 * читаем флаг.
 */
function useCabinetIntroSeen(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => {
      try {
        return window.localStorage.getItem(CABINET_INTRO_KEY) !== null;
      } catch {
        // приватный режим без localStorage — интро просто не показываем
        return true;
      }
    },
    () => true,
  );
}

/**
 * Открыта ли экранная клавиатура. Спрашивается у окна, а не у полей: полей
 * много (вкладки и листы), клавиатура одна. На iOS она ужимает видимую часть
 * окна (`visualViewport`), на Android WebView ужимается всё окно — поэтому
 * сравнение идёт с наибольшей высотой, какую окно видело в этой ориентации.
 */
function useKeyboardOpen(): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    let tallest = window.innerHeight;
    const check = () => {
      tallest = Math.max(tallest, window.innerHeight);
      setOpen(tallest - viewport.height > KEYBOARD_MIN_PX);
    };
    const onRotate = () => {
      tallest = window.innerHeight;
      check();
    };
    viewport.addEventListener('resize', check);
    window.addEventListener('orientationchange', onRotate);
    return () => {
      viewport.removeEventListener('resize', check);
      window.removeEventListener('orientationchange', onRotate);
    };
  }, []);
  return open;
}

/** Видно ли приложение: скрытое не опрашивает сервер (тикет 08). */
function usePageVisible(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      document.addEventListener('visibilitychange', onChange);
      return () => document.removeEventListener('visibilitychange', onChange);
    },
    () => document.visibilityState !== 'hidden',
    () => true,
  );
}

type IssuingInfo = { orderId: string; usdCents: number | null; siteHost: string | null };

function issuingInfoFrom(order: OrderDetail): IssuingInfo {
  return {
    orderId: order.orderId,
    usdCents: order.originalCurrency === 'USD' ? order.originalAmount : null,
    siteHost: siteHostFromUrl(order.instructions?.paymentUrl),
  };
}

/** Касание начато там, где жест принадлежит элементу, а не ряду вкладок. */
function isSwipeIgnoredTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest('input, textarea, select, [contenteditable], [data-swipe-ignore]') !== null
  );
}

/** Положение ряда: вкладка `index` в кадре, плюс смещение под пальцем. */
function trackTransform(index: number, offsetPx = 0): string {
  return `translate3d(calc(${-index} * 100% / ${CABINET_TABS.length} + ${offsetPx}px), 0, 0)`;
}

/**
 * Поставить ряд против вкладки `index` с доездом за `durationMs`. Пишется прямо
 * в узел и ДО рендера React: анимацию transform ведёт компоновщик, и ряд едет
 * с первого же кадра, даже пока React ещё перерисовывает оболочку. Раньше
 * положение писал эффект после рендера — ряд стоял, пока шёл рендер, и
 * касание казалось «проглоченным».
 */
function placeTrack(node: HTMLElement, index: number, durationMs: number): void {
  node.style.setProperty('--settle-ms', `${durationMs}ms`);
  node.style.transform = trackTransform(index);
}

/**
 * Отложить работу до простоя браузера. На iOS `requestIdleCallback` нет —
 * там короткая пауза: монтировать соседние вкладки сразу после первого кадра
 * значит отнять этот кадр у клиента.
 */
function whenIdle(run: () => void): () => void {
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(run, { timeout: 1500 });
    return () => window.cancelIdleCallback(id);
  }
  const timer = window.setTimeout(run, 400);
  return () => window.clearTimeout(timer);
}

/*
 * Вкладки перерисовываются только от своих данных. Оболочка меняет состояние
 * часто — вкладка, лист, плашка, шаг опроса, — и без memo каждое такое
 * изменение заново строило содержимое всех трёх вкладок: на слабом телефоне
 * это десятки миллисекунд прямо в кадре, где начинается анимация.
 */
const PayTabView = memo(PayTab);
const CardTabView = memo(CardTab);
const ProfileTabView = memo(ProfileTab);

export function CabinetClient({ previewSnapshot }: { previewSnapshot?: Snapshot } = {}) {
  const preview = previewSnapshot !== undefined;
  const [phase, setPhase] = useState<Phase>(preview ? 'ready' : 'loading');
  const [errorText, setErrorText] = useState('');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(previewSnapshot ?? null);

  const [tab, setTab] = useState<CabinetTab>('pay');
  const [mounted, setMounted] = useState<readonly CabinetTab[]>(['pay']);
  const [sheet, setSheet] = useState<SheetState | null>(null);

  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [busy, setBusy] = useState<'pay' | null>(null);
  const [actionMsg, setActionMsg] = useState<DetailActionMessage | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [issueNote, setIssueNote] = useState<DetailActionMessage | null>(null);

  // Ожидание оплаты после ухода на страницу шлюза (тикет 08).
  const [awaiting, setAwaiting] = useState<{ orderId: string; startedAt: number } | null>(null);
  const [pollTick, setPollTick] = useState(0);
  // Сколько ляжет на карту и где оформлять — из детали заказа, пока карта
  // выпускается (тикет 06): в сводке заказа ни долларов, ни правил сервиса нет.
  const [issuingInfo, setIssuingInfo] = useState<IssuingInfo | null>(null);

  // Онбординг: показ при первом входе (флаг в localStorage) + повтор из
  // «Профиля» и полоски трёх шагов; после первого закрытия разово
  // подсвечиваем вкладку «Оплата».
  const introSeen = useCabinetIntroSeen();
  const [introDismissed, setIntroDismissed] = useState(false);
  const [forceIntro, setForceIntro] = useState(false);
  const [highlightTab, setHighlightTab] = useState<CabinetTab | null>(null);

  const tgRef = useRef<TelegramWebApp | null>(null);
  const initDataRef = useRef<string>('');
  // initData в state (а не только в ref) — нужно при рендере листов с
  // собственными запросами (PartnerCabinet, реквизиты, каталог).
  const [initData, setInitData] = useState('');
  // Возможности клиента Telegram — в state: ref при рендере читать нельзя.
  // На стенде (preview) «закрыть» — пустое действие, но пункты видны.
  const [canCloseApp, setCanCloseApp] = useState(preview);
  const [canRequestContact, setCanRequestContact] = useState(false);
  const [mainButton, setMainButton] = useState<TelegramMainButton | null>(null);

  const keyboardOpen = useKeyboardOpen();
  const visible = usePageVisible();
  const catalog = useCatalog(phase === 'ready');

  // ─── Живой баланс карты (PaySpace) — после снапшота, в фоне ──────────────
  const cardLiveAtRef = useRef<number | null>(null);
  const cardLiveSeqRef = useRef(0);
  const refreshCardLive = useCallback(async (force: boolean) => {
    const now = Date.now();
    if (!shouldRefreshCardLive(cardLiveAtRef.current, now, force)) return;
    cardLiveAtRef.current = now;
    const seq = ++cardLiveSeqRef.current;
    const res = await fetchCardLive(initDataRef.current);
    // Применяется только ответ на последний запрос: ответы не упорядочены.
    if (!res.ok || !res.data || seq !== cardLiveSeqRef.current) return;
    const live = res.data;
    setSnapshot((s) => (s ? applyCardLive(s, live) : s));
  }, []);

  // ─── Инициализация: SDK Telegram ∥ snapshot ∥ каталог ────────────────────
  useEffect(() => {
    if (preview) return; // превью/QA-seam: рендер без Telegram
    let cancelled = false;
    // Три запроса стартуют разом, а не цепочкой «SDK → снапшот → каталог»:
    // initData есть в адресе запуска, витрина публичная.
    prefetchCatalog();
    const launchInitData = readLaunchInitData();
    const earlySnapshot = launchInitData ? fetchSnapshot(launchInitData) : null;
    void (async () => {
      const tg = await loadTelegramWebApp();
      if (cancelled) return;
      if (!tg || !tg.initData) {
        setPhase('no-telegram');
        return;
      }
      tgRef.current = tg;
      initDataRef.current = tg.initData;
      setInitData(tg.initData);
      setCanCloseApp(typeof tg.close === 'function');
      setCanRequestContact(typeof tg.requestContact === 'function');
      setMainButton(tg.MainButton ?? null);
      tolerateTelegram(() => {
        tg.ready();
        tg.expand();
        if (tg.colorScheme === 'light' || tg.colorScheme === 'dark') {
          document.documentElement.dataset.theme = tg.colorScheme;
        }
        // Подгоняем chrome Telegram (шапка/фон/низ) под фирменный --bg, иначе
        // поверх halftone видны чёрные полосы Telegram (фидбек владельца).
        const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
        if (bg) {
          tg.setBackgroundColor?.(bg);
          tg.setHeaderColor?.(bg);
          tg.setBottomBarColor?.(bg);
        }
      });
      // Без этого потяг листа или прокрутка вкладки вниз сворачивали Mini App
      // (тикет 03). Отдельным вызовом: в старых клиентах метод бросает.
      tolerateTelegram(() => tg.disableVerticalSwipes?.());

      // Ранний ответ годится, только если SDK видит ту же initData, — иначе
      // снапшот запрашивается заново по строке SDK.
      const res =
        earlySnapshot && tg.initData === launchInitData ? await earlySnapshot : await fetchSnapshot(tg.initData);
      if (cancelled) return;
      if (res.ok) {
        setSnapshot(res.data);
        setPhase('ready');
        if (res.data.cards.length > 0) void refreshCardLive(true);
      } else {
        setErrorText(errorTextFor(res.error));
        setPhase('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [preview, refreshCardLive]);

  // Открытие кабинета — ОДИН раз на вход, а не на каждую вкладку. Ref-гейт:
  // StrictMode монтирует эффекты дважды.
  const cabinetOpenSentRef = useRef(false);
  useEffect(() => {
    if (cabinetOpenSentRef.current || !snapshot) return;
    cabinetOpenSentRef.current = true;
    track('cabinet_open', { entry: preview ? 'preview' : 'telegram' });
  }, [snapshot, preview]);

  /**
   * Перечитать снапшот. Живой баланс карты — следом и не чаще раза в 15 с;
   * `forceLive` — без паузы (возврат в приложение: клиент мог только что
   * оплатить подписку картой).
   */
  const reloadSnapshot = useCallback(
    async (opts?: { forceLive?: boolean }) => {
      const res = await fetchSnapshot(initDataRef.current);
      if (!res.ok) return;
      setSnapshot(res.data);
      if (res.data.cards.length > 0) void refreshCardLive(opts?.forceLive ?? false);
    },
    [refreshCardLive],
  );

  const openExternalLink = useCallback((url: string) => {
    const tg = tgRef.current;
    if (tg) tg.openLink(url);
    else window.open(url, '_blank', 'noopener,noreferrer');
  }, []);

  const haptic = useCallback((kind: 'tick' | 'success' | 'select') => {
    const h = tgRef.current?.HapticFeedback;
    tolerateTelegram(() => {
      if (kind === 'success') h?.notificationOccurred?.('success');
      else if (kind === 'select') h?.selectionChanged?.();
      else h?.impactOccurred?.('light');
    });
  }, []);

  // Плашка уведомления оболочки гаснет сама.
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // ─── Вкладки ──────────────────────────────────────────────────────────────
  const tabRef = useRef<CabinetTab>('pay');
  const frameRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);

  /**
   * Смена вкладки — одна функция на панель, свайп и автопереход после оплаты
   * (тикет 01): три входа не могут прийти к разным состояниям.
   */
  const go = useCallback(
    (next: CabinetTab, via: 'tap' | 'swipe' | 'auto') => {
      // Свайп ставит ряд сам — с доездом по скорости пальца; остальные входы
      // ставят его здесь, до рендера (см. `placeTrack`).
      const node = trackRef.current;
      if (node && via !== 'swipe') placeTrack(node, CABINET_TABS.indexOf(next), SETTLE_MS);
      setMounted((were) => (were.includes(next) ? were : [...were, next]));
      if (next === tabRef.current) return;
      tabRef.current = next;
      setTab(next);
      track('cabinet_tab_view', { tab: next, via });
      if (via !== 'auto') haptic('select');
    },
    [haptic],
  );

  // Ряд встаёт против выбранной вкладки записью в узел, а не свойством
  // разметки: под пальцем положение меняется по многу раз в секунду, и держать
  // его состоянием значило бы гонять React на каждое касание. Эффект — только
  // подстраховка первого показа: смену вкладки узел получает раньше, в `go`,
  // и та же строка transform повторно анимацию не запускает.
  useEffect(() => {
    trackRef.current?.style.setProperty('transform', trackTransform(CABINET_TABS.indexOf(tab)));
  }, [tab, phase]);

  // Соседние вкладки монтируются в простое после первого показа, а не в
  // момент перехода: иначе первый свайп строил вкладку прямо под пальцем, и
  // первые кадры переноса проседали. Прерываемо — касание во время монтажа
  // обрабатывается сразу.
  useEffect(() => {
    if (phase !== 'ready') return;
    return whenIdle(() => startTransition(() => setMounted(CABINET_TABS)));
  }, [phase]);

  // Свайп блокируют открытый лист, онбординг и клавиатура.
  const introFirstRun = !introSeen && !forceIntro;
  const showIntro =
    phase === 'ready' && !!snapshot && (forceIntro || (!introSeen && !introDismissed));
  const swipeBlockedRef = useRef(false);
  useEffect(() => {
    swipeBlockedRef.current = sheet !== null || showIntro || keyboardOpen;
  }, [sheet, showIntro, keyboardOpen]);

  const goRef = useRef(go);
  useEffect(() => {
    goRef.current = go;
  });

  /*
   * Перенос пальцем (тикет 02). Обработчики — руками, а не свойствами
   * разметки: остановить прокрутку у переноса можно только слушателем,
   * объявленным неуступчивым (`passive: false`), а React вешает свои иначе.
   */
  useEffect(() => {
    const frame = frameRef.current;
    const node = trackRef.current;
    if (phase !== 'ready' || !frame || !node) return;

    let startX = 0;
    let startY = 0;
    let dx = 0;
    let axis: 'x' | 'y' | null = null;
    let tracking = false;
    let width = 0;
    let raf = 0;
    // Последние точки пути пальца — по ним скорость в момент отпускания.
    let samples: SwipeSample[] = [];

    const index = () => CABINET_TABS.indexOf(tabRef.current);
    const paint = () => {
      raf = 0;
      node.style.transform = trackTransform(index(), dragOffset(dx, index(), CABINET_TABS.length));
    };
    const stop = () => {
      tracking = false;
      axis = null;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      delete node.dataset.dragging;
    };

    const start = (event: TouchEvent) => {
      const touch = event.touches[0];
      // Двумя пальцами вкладки не листают: это масштаб или случайное касание.
      if (event.touches.length !== 1 || !touch) return;
      if (swipeBlockedRef.current) return;
      if (startsInEdgeGuard(touch.clientX)) return;
      if (isSwipeIgnoredTarget(event.target)) return;
      startX = touch.clientX;
      startY = touch.clientY;
      dx = 0;
      axis = null;
      tracking = true;
      width = frame.clientWidth;
      samples = [{ t: event.timeStamp, x: touch.clientX }];
    };

    const move = (event: TouchEvent) => {
      if (!tracking) return;
      const touch = event.touches[0];
      if (event.touches.length !== 1 || !touch) {
        stop();
        placeTrack(node, index(), SETTLE_MS);
        return;
      }
      dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      samples.push({ t: event.timeStamp, x: touch.clientX });
      if (samples.length > 12) samples.shift();
      if (!axis) {
        axis = lockAxis(dx, dy);
        if (!axis) return;
        if (axis === 'y') {
          // Жест — прокрутка вкладки; ряд его больше не слушает.
          tracking = false;
          return;
        }
        // Сосед заводится сразу, как стало ясно направление: в кадр он
        // въезжает уже с содержимым.
        const neighbour = CABINET_TABS[index() + (dx < 0 ? 1 : -1)];
        if (neighbour) setMounted((were) => (were.includes(neighbour) ? were : [...were, neighbour]));
        node.dataset.dragging = '';
      }
      // Иначе вместе с переносом поедет и прокрутка внутри вкладки.
      if (event.cancelable) event.preventDefault();
      if (!raf) raf = requestAnimationFrame(paint);
    };

    const end = () => {
      if (!tracking) return;
      const wasX = axis === 'x';
      const from = index();
      const velocity = releaseVelocity(samples);
      const target = resolveSwipe(dx, width, from, CABINET_TABS.length, velocity);
      // Сколько ряду осталось проехать и в какую сторону: сейчас он стоит на
      // `-from·w + offset`, встать должен на `-target·w`.
      const travel = (from - target) * width - dragOffset(dx, from, CABINET_TABS.length);
      // stop() снимает и отложенный кадр переноса — иначе он перезаписал бы
      // положение, выставленное ниже.
      stop();
      if (!wasX) return;
      const towardTarget = travel !== 0 && Math.sign(velocity) === Math.sign(travel);
      placeTrack(node, target, settleDurationMs(Math.abs(travel), width, velocity, towardTarget));
      const next = CABINET_TABS[target];
      if (next && target !== from) goRef.current(next, 'swipe');
    };

    // Жест отняла система (звонок, жест от края, смена приложения) — ряд
    // возвращается на место: клиент вкладку не менял.
    const cancel = () => {
      if (!tracking) return;
      stop();
      placeTrack(node, index(), SETTLE_MS);
    };

    frame.addEventListener('touchstart', start, { passive: true });
    frame.addEventListener('touchmove', move, { passive: false });
    frame.addEventListener('touchend', end);
    frame.addEventListener('touchcancel', cancel);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      frame.removeEventListener('touchstart', start);
      frame.removeEventListener('touchmove', move);
      frame.removeEventListener('touchend', end);
      frame.removeEventListener('touchcancel', cancel);
    };
  }, [phase]);

  // ─── Лист заказа ──────────────────────────────────────────────────────────
  // Заказ, открытый в листе прямо сейчас: ответы отставших запросов (клиент
  // успел закрыть лист или открыть другой заказ) не должны перезаписать detail.
  const activeOrderIdRef = useRef<string | null>(null);
  // Номер последнего запроса детали: применяется только ответ на него.
  const detailSeqRef = useRef(0);
  const awaitingRef = useRef<{ orderId: string; startedAt: number } | null>(null);
  const busyRef = useRef(false);

  const closeSheet = useCallback(() => {
    const wasOrder = activeOrderIdRef.current !== null;
    activeOrderIdRef.current = null;
    awaitingRef.current = null;
    setAwaiting(null);
    setSheet(null);
    setDetail(null);
    setActionMsg(null);
    setIssueNote(null);
    // Закрытый заказ мог поменяться (оплачен, отменён) — «Ждут оплаты» и
    // «Карта» перечитываются.
    if (wasOrder) void reloadSnapshot();
  }, [reloadSnapshot]);

  const openOrder = useCallback(async (orderId: string, hint: OrderHint | null = null) => {
    setActionMsg(null);
    setNotice(null);
    setDetail(null);
    setSheet({ kind: 'order', orderId, hint });
    activeOrderIdRef.current = orderId;
    const seq = ++detailSeqRef.current;
    const res = await fetchOrderDetail(initDataRef.current, orderId);
    // Уже смотрим другой заказ — или по этому ушёл запрос новее.
    if (activeOrderIdRef.current !== orderId || seq !== detailSeqRef.current) return;
    if (res.ok) {
      setDetail(res.data);
    } else {
      activeOrderIdRef.current = null;
      setSheet(null);
      // Текст по коду, а не единый «попробуй ещё раз»: на 429 повтор только
      // добивает окно, на протухшей подписи — не помогает вовсе.
      setNotice(errorTextFor(res.error));
    }
  }, []);

  /**
   * Деньги пришли (тикет 08): лист закрывается, приложение само ведёт на
   * «Карту». Снапшот правится сразу по детали — вкладка показывает «Выпускаю
   * карту…», не дожидаясь перечитывания, — и перечитывается следом.
   */
  const finishToCard = useCallback(
    (paid: OrderDetail) => {
      setSnapshot((s) => {
        if (!s) return s;
        const orders = s.orders.map((o) =>
          o.orderId === paid.orderId
            ? { ...o, status: paid.status, statusLabel: paid.statusLabel, cardId: paid.cardId ?? o.cardId ?? null }
            : o,
        );
        const cards =
          paid.card && !s.cards.some((c) => c.id === paid.card?.id) ? [paid.card, ...s.cards] : s.cards;
        return { ...s, orders, cards };
      });
      setIssuingInfo(issuingInfoFrom(paid));
      activeOrderIdRef.current = null;
      awaitingRef.current = null;
      setAwaiting(null);
      setSheet(null);
      setDetail(null);
      setActionMsg(null);
      go('card', 'auto');
      haptic('success');
      void reloadSnapshot();
    },
    [go, haptic, reloadSnapshot],
  );

  /**
   * Перечитать открытый заказ. Возвращает код ошибки ответа (`null` — успех
   * или ответ уже не нужен): по `rate_limited` опрос отступает, а не долбит
   * бакет `cabinet` тем же шагом.
   */
  const refreshDetail = useCallback(
    async (orderId: string): Promise<string | null> => {
      const seq = ++detailSeqRef.current;
      const res = await fetchOrderDetail(initDataRef.current, orderId);
      if (!res.ok) return res.error;
      // Ответы не упорядочены: опоздавший `pending_payment` после свежего
      // `payment_review` вернул бы экран к «Оплатить» и выключил опрос.
      if (activeOrderIdRef.current !== orderId || seq !== detailSeqRef.current) return null;
      const waiting = awaitingRef.current;
      if (waiting?.orderId === orderId) {
        if (afterPaymentOutcome(res.data.status) === 'to_card') {
          finishToCard(res.data);
          return null;
        }
        // Банк держит платёж, счёт протух, отменён — опрос окончен, лист
        // остаётся и показывает статус.
        if (res.data.status !== 'pending_payment') {
          awaitingRef.current = null;
          setAwaiting(null);
        }
      }
      setDetail(res.data);
      return null;
    },
    [finishToCard],
  );

  // Опрос заказа после ухода на оплату: раз в 5 с (после 429 — реже), пока
  // счёт выставлен и приложение на экране, не дольше 10 минут (тикет 08).
  const detailStatus = detail?.status ?? null;
  const pollOrderId = pollTargetOrderId(awaiting, detail?.orderId ?? null);
  const lastPollErrorRef = useRef<string | null>(null);
  useEffect(() => {
    if (!awaiting || pollOrderId === null || detailStatus === null) return;
    const elapsed = Date.now() - awaiting.startedAt;
    if (elapsed >= POLL_MAX_MS) {
      const timer = window.setTimeout(() => {
        awaitingRef.current = null;
        setAwaiting(null);
      }, 0);
      return () => window.clearTimeout(timer);
    }
    if (!shouldPoll(detailStatus, elapsed, visible)) return;
    const timer = window.setTimeout(() => {
      void refreshDetail(pollOrderId).then((error) => {
        lastPollErrorRef.current = error;
        setPollTick((t) => t + 1);
      });
    }, nextPollDelayMs(lastPollErrorRef.current));
    return () => window.clearTimeout(timer);
  }, [awaiting, pollOrderId, detailStatus, visible, pollTick, refreshDetail]);

  // Возврат в приложение (из браузера со страницей оплаты) — сразу перечитать
  // открытый заказ и снапшот, не дожидаясь шага опроса (тикет 08). Событий
  // возврата два (`visibilitychange` и `activated`) — второе в том же окне
  // пропускаем: следом за снапшотом идёт запрос живого баланса в PaySpace.
  const lastReturnAtRef = useRef<number | null>(null);
  const onAppReturn = useCallback(() => {
    const now = Date.now();
    if (isDuplicateReturn(lastReturnAtRef.current, now)) return;
    lastReturnAtRef.current = now;
    const orderId = activeOrderIdRef.current;
    if (orderId) void refreshDetail(orderId);
    void reloadSnapshot({ forceLive: true });
  }, [refreshDetail, reloadSnapshot]);
  const wasVisibleRef = useRef(true);
  useEffect(() => {
    if (phase !== 'ready') return;
    if (visible && !wasVisibleRef.current) onAppReturn();
    wasVisibleRef.current = visible;
  }, [visible, phase, onAppReturn]);
  useEffect(() => {
    const tg = tgRef.current;
    if (phase !== 'ready' || !tg?.onEvent) return;
    const handler = () => onAppReturn();
    tolerateTelegram(() => tg.onEvent?.('activated', handler));
    return () => tolerateTelegram(() => tg.offEvent?.('activated', handler));
  }, [phase, onAppReturn]);

  // ─── Действия листа заказа ────────────────────────────────────────────────
  // «Не проходит оплата?» — по заказу из открытого листа или из «Карты».
  const reportIssueFor = useCallback(
    async (orderId: string, issueType: PaymentIssueType, comment?: string) => {
      const res = await doReportPaymentIssue(initDataRef.current, orderId, issueType, comment);
      if (res.ok && activeOrderIdRef.current === orderId) void refreshDetail(orderId);
      return res;
    },
    [refreshDetail],
  );

  const reportIssue = useCallback(
    async (issueType: PaymentIssueType, comment?: string) => {
      if (!detail) {
        return { ok: false as const, error: 'no_order', message: 'Заказ не открыт.' };
      }
      return reportIssueFor(detail.orderId, issueType, comment);
    },
    [detail, reportIssueFor],
  );

  // «Проблема с оплатой» — фаза до выпуска: после отправки перечитываем деталь
  // (для «я оплатил» статус станет «на проверке банка»).
  const reportPaymentProblem = useCallback(
    async (problemType: PaymentProblemType, comment?: string) => {
      if (!detail) {
        return { ok: false as const, error: 'no_order', message: 'Заказ не открыт.' };
      }
      const res = await doReportPaymentProblem(initDataRef.current, detail.orderId, problemType, comment);
      if (res.ok) void refreshDetail(detail.orderId);
      return res;
    },
    [detail, refreshDetail],
  );

  // «Подписка оформлена» — фиксируем подтверждение клиента и перечитываем:
  // на «Карте» гаснет «Остался один шаг», в листе — статус заказа.
  const markSubscriptionPaid = useCallback(
    async (orderId: string) => {
      const res = await doMarkSubscriptionPaid(initDataRef.current, orderId);
      if (res.ok) {
        setSnapshot((s) =>
          s
            ? {
                ...s,
                orders: s.orders.map((o) =>
                  o.orderId === orderId ? { ...o, subscriptionActivated: true } : o,
                ),
              }
            : s,
        );
        if (activeOrderIdRef.current === orderId) void refreshDetail(orderId);
        void reloadSnapshot();
      }
      return res;
    },
    [refreshDetail, reloadSnapshot],
  );

  const confirmSubscriptionPaid = useCallback(async () => {
    if (!detail) {
      return { ok: false as const, error: 'no_order', message: 'Заказ не открыт.' };
    }
    return markSubscriptionPaid(detail.orderId);
  }, [detail, markSubscriptionPaid]);

  // «Отменить заказ» — при успехе лист закрывается сам: отменённый заказ
  // перестаёт быть оплатимым, и оставить клиента с кнопкой «Оплатить» значит
  // показать кнопку, которая теперь отвечает отказом.
  const cancelCurrentOrder = useCallback(async (): Promise<CancelOrderResult> => {
    if (!detail) {
      return { ok: false as const, error: 'no_order', message: 'Заказ не открыт.' };
    }
    const res = await doCancelOrder(initDataRef.current, detail.orderId);
    if (res.ok) {
      closeSheet();
      setNotice(res.message);
    }
    return res;
  }, [detail, closeSheet]);

  /**
   * Проверка промокода (трек promo-codes). Ничего не занимает и не трогает
   * `busy`: экран остаётся рабочим, а «Проверяю…» показывает само поле.
   */
  const onCheckPromo = useCallback(
    async (code: string): Promise<PromoCheckResult> => {
      if (!detail) return { ok: false, error: 'not_found' };
      return await checkPromo(initDataRef.current, detail.orderId, code);
    },
    [detail],
  );

  const onPay = useCallback(
    async (contactsToSend: { email?: string; phone?: string }, useBonus: boolean, promoCode?: string) => {
      // Синхронный гейт от повторного нажатия: у своей кнопки и MainButton
      // разные обработчики, а `busy` из state доедет только следующим
      // рендером — второй счёт на заказ нам не нужен.
      if (!detail || busyRef.current) return;
      busyRef.current = true;
      setBusy('pay');
      setActionMsg(null);
      const res = await doPay(initDataRef.current, detail.orderId, contactsToSend, {
        useBonus,
        ...(promoCode ? { promoCode } : {}),
      });
      busyRef.current = false;
      setBusy(null);
      // Лист могли закрыть (или открыть другой заказ), пока готовился счёт:
      // ссылку клиент просил — её открываем, но сообщение и ожидание оплаты
      // принадлежат этому листу и под чужим заказом появиться не должны.
      const stillOpen = activeOrderIdRef.current === detail.orderId;
      if (res.ok && !stillOpen) {
        track('pay_link_click', { surface: 'cabinet' }, { orderRef: detail.shortId, immediate: true });
        openExternalLink(res.paymentUrl);
        void reloadSnapshot();
        return;
      }
      if (!stillOpen) return;
      if (res.ok) {
        setActionMsg({ tone: 'ok', text: 'Счёт готов — открываю оплату.' });
        track(
          'pay_link_click',
          { surface: 'cabinet' },
          // shortId (ORD-...), а НЕ orderId: UUID длиннее лимита схемы приёма —
          // событие вместе со всем батчем отбивалось бы как invalid_body.
          { orderRef: detail.shortId, immediate: true },
        );
        openExternalLink(res.paymentUrl);
        const waiting = { orderId: detail.orderId, startedAt: Date.now() };
        awaitingRef.current = waiting;
        setAwaiting(waiting);
        void refreshDetail(detail.orderId);
        void reloadSnapshot();
      } else {
        setActionMsg({ tone: 'err', text: res.message });
        // Баланс баллов изменился, пока клиент думал: экран обязан показать
        // актуальное состояние, иначе он нажмёт ту же кнопку и получит тот же
        // отказ.
        if (res.error === 'bonus_unavailable') {
          void refreshDetail(detail.orderId);
          void reloadSnapshot();
        }
      }
    },
    [detail, openExternalLink, refreshDetail, reloadSnapshot],
  );

  /*
   * Выход в поддержку: бот присылает в чат кнопку «Поддержка», и кабинет
   * закрывается — клиент оказывается ровно под ней, а не в чате, где кнопку
   * надо искать в меню выше. Своего канала связи у кабинета нет. Не
   * доставилось — кабинет остаётся открытым и говорит, куда нажать: закрыться
   * в чат без кнопки значило бы бросить клиента.
   */
  const supportBusyRef = useRef(false);
  const contactSupport = useCallback(() => {
    if (supportBusyRef.current) return;
    supportBusyRef.current = true;
    haptic('tick');
    void doOpenSupport(initDataRef.current).then((delivered) => {
      supportBusyRef.current = false;
      if (delivered) {
        tgRef.current?.close?.();
        return;
      }
      setNotice('Не получилось открыть поддержку. Закрой приложение и нажми «Поддержка» в чате с ботом.');
    });
  }, [haptic]);

  // «Взять из Telegram»: requestContact НЕ отдаёт номер приложению — Telegram
  // доставляет его боту contact-сообщением. Поэтому после «поделился»
  // перечитываем снапшот с небольшой паузой (номер едет через webhook бота).
  const requestTelegramPhone = useCallback(() => {
    const tg = tgRef.current;
    if (!tg?.requestContact) {
      setNotice('Обнови Telegram или введи номер вручную.');
      return;
    }
    tg.requestContact((shared) => {
      if (!shared) return;
      window.setTimeout(() => {
        void reloadSnapshot();
      }, 1500);
    });
  }, [reloadSnapshot]);

  // Сохранение контактов из листа «Контакты» (вкладка «Профиль»).
  const saveProfileContacts = useCallback(
    async (contacts: { email?: string; phone?: string }) => {
      const res = await doUpdateContacts(initDataRef.current, contacts);
      if (res.ok) {
        void reloadSnapshot();
        return { ok: true as const };
      }
      return { ok: false as const, message: res.message };
    },
    [reloadSnapshot],
  );

  const shareLink = useCallback((url: string) => {
    const tg = tgRef.current;
    if (tg?.openTelegramLink) tg.openTelegramLink(url);
    else window.open(url, '_blank');
  }, []);

  // ─── Онбординг ────────────────────────────────────────────────────────────
  const closeIntro = useCallback(() => {
    try {
      window.localStorage.setItem(CABINET_INTRO_KEY, '1');
    } catch {
      // не записалось — покажем ещё раз в следующий визит, не критично
    }
    setIntroDismissed(true);
    setForceIntro(false);
    // Только на первом показе подсвечиваем вкладку «Оплата» — прямо отвечаем
    // на «куда нажимать». Повтор подсветку не запускает.
    if (introFirstRun) {
      setHighlightTab('pay');
      window.setTimeout(() => setHighlightTab(null), 3600);
    }
  }, [introFirstRun]);

  const introHaptic = useCallback((kind: 'tick' | 'success') => haptic(kind), [haptic]);

  // ─── Производные снапшота ─────────────────────────────────────────────────
  const cardState = useMemo(
    () => (snapshot ? selectCardTabState(snapshot) : ({ kind: 'none' } as const)),
    [snapshot],
  );
  const issuingOrderId = cardState.kind === 'issuing' ? cardState.order.orderId : null;

  /*
   * Слежка за выпуском карты (тикет 08): пока заказ оплачен, а карты нет,
   * вкладка «Карта» перечитывает заказ раз в 5 с и, как только карта выдана,
   * перечитывает снапшот — «Выпускаю карту…» сменяется карточкой «Остался один
   * шаг» без перезахода. Заодно из детали берётся сумма «на неё ляжет $X».
   *
   * Пока лист ждёт подтверждения другой оплаты, слежка стоит: две петли по 5 с
   * вместе с возвратами в приложение выедали бы бакет `cabinet` (30 в минуту),
   * и «Оплатить» получало бы отказ из-за фонового чтения (находка ревью).
   */
  const paymentPolling = awaiting !== null;
  // Только пока открыта «Карта»: смотреть на выпуск больше негде, а фоновый
  // опрос с другой вкладки только тратил бы лимит.
  const watchIssuing = issuingOrderId !== null && tab === 'card' && visible && !paymentPolling;
  useEffect(() => {
    if (!watchIssuing || !issuingOrderId) return;
    let cancelled = false;
    let timer: number | undefined;
    const startedAt = Date.now();
    const tick = async () => {
      const res = await fetchOrderDetail(initDataRef.current, issuingOrderId);
      if (cancelled) return;
      if (res.ok) {
        setIssuingInfo(issuingInfoFrom(res.data));
        if (!shouldWatchIssuing(res.data.status, Date.now() - startedAt, true)) {
          if (res.data.status !== 'paid' && res.data.status !== 'in_fulfillment') {
            void reloadSnapshot();
          }
          return;
        }
      }
      if (Date.now() - startedAt >= POLL_MAX_MS) return;
      timer = window.setTimeout(() => void tick(), nextPollDelayMs(res.ok ? null : res.error));
    };
    void tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [watchIssuing, issuingOrderId, reloadSnapshot]);

  // «Остался один шаг» увидели — раз за вход (тикет 10).
  const nextStepSentRef = useRef(false);
  const nextStepVisible = tab === 'card' && cardState.kind === 'active' && cardState.nextStep !== null;
  useEffect(() => {
    if (!nextStepVisible || nextStepSentRef.current) return;
    nextStepSentRef.current = true;
    track('card_next_step_view');
  }, [nextStepVisible]);

  // ─── Пропсы вкладок: те же ссылки между рендерами (вкладки под memo) ─────
  const onOpenOrderTap = useCallback((orderId: string) => void openOrder(orderId), [openOrder]);
  const onOpenService = useCallback((service: CatalogService) => setSheet({ kind: 'service', service }), []);
  const onOpenIntro = useCallback(() => setForceIntro(true), []);
  const onGoPay = useCallback(() => go('pay', 'tap'), [go]);
  const onOpenCardDetails = useCallback((cardId: string) => setSheet({ kind: 'card-details', cardId }), []);
  const onOpenIssue = useCallback((orderId: string) => {
    setIssueNote(null);
    setSheet({ kind: 'card-issue', orderId });
  }, []);
  const onOpenPartner = useCallback(() => setSheet({ kind: 'partner' }), []);
  const onEditContacts = useCallback(() => setSheet({ kind: 'contacts' }), []);
  const supportAction = canCloseApp ? contactSupport : undefined;
  const issuingForTab = issuingInfo && issuingInfo.orderId === issuingOrderId ? issuingInfo : null;
  // «Ждут оплаты»: оплатимые заказы с ещё живым сроком, самые срочные сверху.
  // Пересчёт и на смене вкладки: срок живёт часами, и заказ, протухший, пока
  // клиент был на другой вкладке, не должен ждать нового снапшота.
  const pendingOrders = useMemo(
    () => (snapshot ? selectPendingPaymentOrders(snapshot.orders) : []),
    // `tab` в зависимостях намеренно — см. выше.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snapshot, tab],
  );

  // ─── Рендер ──────────────────────────────────────────────────────────────
  if (phase === 'loading') {
    return <CabinetLoader />;
  }
  if (phase === 'no-telegram') {
    return (
      <CenteredNote
        title="Открой кабинет в Telegram"
        text="Личный кабинет работает внутри Telegram. Открой бота, отправь /start и нажми «Открыть приложение»."
      />
    );
  }
  if (phase === 'error' || !snapshot) {
    return <CenteredNote title="Что-то пошло не так" text={errorText || 'Попробуй обновить страницу.'} />;
  }

  const firstName = snapshot.profile.displayName?.trim().split(/\s+/)[0];
  const greeting = firstName ? `Привет, ${firstName}!` : 'Привет!';
  const blockedByOverlay = sheet !== null || showIntro;

  const screens: Record<CabinetTab, React.ReactNode> = {
    pay: (
      <PayTabView
        greeting={greeting}
        pendingOrders={pendingOrders}
        catalog={catalog}
        onOpenOrder={onOpenOrderTap}
        onOpenService={onOpenService}
        onOpenIntro={onOpenIntro}
        onContactSupport={supportAction}
      />
    ),
    card: (
      <CardTabView
        state={cardState}
        issuing={issuingForTab}
        onGoPay={onGoPay}
        onOpenCardDetails={onOpenCardDetails}
        onOpenOrder={onOpenOrderTap}
        onOpenIssue={onOpenIssue}
        onMarkSubscriptionPaid={markSubscriptionPaid}
        onOpenExternalLink={openExternalLink}
        onContactSupport={supportAction}
      />
    ),
    profile: (
      <ProfileTabView
        profile={snapshot.profile}
        referralLink={snapshot.referralLink}
        phoneRequiredFromRub={snapshot.phoneRequiredFromRub}
        onOpenPartner={onOpenPartner}
        onEditContacts={onEditContacts}
        onOpenIntro={onOpenIntro}
        onContactSupport={supportAction}
        onShare={shareLink}
      />
    ),
  };

  return (
    <div className="relative flex h-[100dvh] w-full flex-col overflow-hidden">
      <div ref={frameRef} inert={blockedByOverlay} className="relative min-h-0 flex-1 overflow-hidden">
        <div
          ref={trackRef}
          className="flex h-full w-[300%] transition-transform duration-[var(--settle-ms,250ms)] ease-out will-change-transform data-[dragging]:transition-none"
        >
          {CABINET_TABS.map((id) => (
            <div
              key={id}
              // Неактивная вкладка остаётся в дереве (состояние и прокрутка
              // переживают переключение), но недоступна диктору и клавише Tab.
              inert={id !== tab}
              aria-hidden={id !== tab}
              className="h-full w-1/3 touch-pan-y overflow-y-auto overscroll-y-contain"
            >
              <main className="mx-auto w-full max-w-md px-4 pt-[18px] pb-[calc(96px+env(safe-area-inset-bottom))]">
                {mounted.includes(id) ? screens[id] : null}
              </main>
            </div>
          ))}
        </div>
      </div>

      {/* Над листами (z-60): уведомления приходят и из открытого листа —
          «поддержка не открылась», «обнови Telegram» у контактов, — а под
          листом их не было видно. Гаснет само и по тапу. */}
      {notice && (
        <button
          type="button"
          role="status"
          onClick={() => setNotice(null)}
          className="absolute inset-x-3 bottom-[calc(84px+env(safe-area-inset-bottom))] z-[70] mx-auto max-w-md rounded-[12px] border-2 border-[var(--shadow-ink)] bg-[var(--surface-2)] px-3.5 py-2.5 text-left font-body text-sm text-[var(--text)] shadow-[3px_3px_0_var(--shadow-ink)]"
        >
          {notice}
        </button>
      )}

      <TabBar
        tab={tab}
        onSelect={(next) => {
          setHighlightTab(null);
          go(next, 'tap');
        }}
        hidden={keyboardOpen}
        highlight={highlightTab}
        inert={blockedByOverlay}
      />

      {sheet && renderSheet()}

      {showIntro && <CabinetIntro onClose={closeIntro} haptic={introHaptic} />}
    </div>
  );

  function renderSheet() {
    if (!sheet || !snapshot) return null;
    switch (sheet.kind) {
      case 'service':
        return (
          <Sheet
            title={sheet.service.name}
            subtitle={sheet.service.requiresKyc ? 'может понадобиться верификация (KYC)' : undefined}
            onClose={closeSheet}
          >
            <ServicePicker
              service={sheet.service}
              initData={initData}
              buyerFeePercent={catalog.buyerFeePercent}
              onOpenExternalLink={openExternalLink}
              // Заказ создан — в ТОМ ЖЕ листе экран заказа (тикет 04).
              onCreated={(orderId, hint) => void openOrder(orderId, hint)}
            />
          </Sheet>
        );
      case 'order': {
        const title = orderSheetTitle(detail, sheet.hint);
        return (
          <Sheet title={title.title} subtitle={title.subtitle} onClose={closeSheet} flushBottom={detail?.payable === true}>
            {detail && detail.orderId === sheet.orderId ? (
              <OrderDetailView
                order={detail}
                // Факт наличия карты — из снапшота, НЕ из fee=0 заказа (L-22).
                hasActiveCard={snapshot.cards.some((c) => c.status === 'active')}
                onCheckPromo={onCheckPromo}
                busy={busy}
                message={actionMsg}
                // Prefill плашки контактов — из profile снапшота.
                savedEmail={snapshot.profile.email}
                savedPhone={snapshot.profile.phone}
                phoneSource={snapshot.profile.phoneSource}
                phoneRequiredFromRub={snapshot.phoneRequiredFromRub}
                awaitingPayment={awaiting?.orderId === detail.orderId}
                mainButton={mainButton}
                onRequestTelegramPhone={canRequestContact ? requestTelegramPhone : undefined}
                onPay={(contacts, useBonus, promoCode) => void onPay(contacts, useBonus, promoCode)}
                onOpenExternalLink={openExternalLink}
                onReportIssue={reportIssue}
                onReportPaymentProblem={reportPaymentProblem}
                onSubscriptionPaid={confirmSubscriptionPaid}
                onCancel={cancelCurrentOrder}
                onContactSupport={canCloseApp ? contactSupport : undefined}
              />
            ) : (
              // Высота — заранее, почти как у экрана заказа: иначе лист
              // выезжал низкой полоской и рывком вырастал, когда приходила
              // деталь, — это читалось как подвисание.
              <p role="status" className="min-h-[60dvh] pt-6 text-center font-body text-sm text-[var(--text-muted)]">
                Открываю заказ…
              </p>
            )}
          </Sheet>
        );
      }
      case 'partner':
        return (
          <Sheet ariaLabel="Партнёрская программа" onClose={closeSheet} bare>
            <PartnerCabinet initData={initData} onBack={closeSheet} />
          </Sheet>
        );
      case 'contacts':
        return (
          <Sheet title="Контакты" onClose={closeSheet}>
            <ProfileView
              // key: перезаход в форму при изменении контактов на сервере —
              // после «Взять из Telegram» номер приходит через бота.
              key={`${snapshot.profile.email ?? ''}|${snapshot.profile.phone ?? ''}`}
              profile={snapshot.profile}
              onSave={saveProfileContacts}
              onRequestTelegramPhone={canRequestContact ? requestTelegramPhone : undefined}
            />
          </Sheet>
        );
      case 'card-details':
        return (
          <Sheet title="Реквизиты карты" onClose={closeSheet}>
            <CardDetailsSheet initData={initData} cardId={sheet.cardId} />
          </Sheet>
        );
      case 'card-issue': {
        const orderId = sheet.orderId;
        const instructions =
          cardState.kind === 'active' && cardState.card.purposeOrderId === orderId
            ? cardState.card.instructions
            : null;
        return (
          <Sheet title="Не получается оплатить?" onClose={closeSheet}>
            <div className="flex flex-col gap-3">
              <ServiceInstructions instructions={instructions} />
              <ComicButton
                variant="surface"
                className="w-full px-4 py-2.5 text-sm"
                onClick={() => openExternalLink(`${window.location.origin}/payment-instruction.html`)}
              >
                Инструкция по оплате
              </ComicButton>
              {issueNote ? (
                <p
                  role="status"
                  className={[
                    'rounded-[12px] border-2 px-3 py-2 font-body text-sm',
                    issueNote.tone === 'ok'
                      ? 'border-[var(--color-teal-deep)] text-[var(--text)]'
                      : 'border-[var(--color-stamp)] text-[var(--color-stamp)]',
                  ].join(' ')}
                >
                  {issueNote.text}
                </p>
              ) : null}
              {issueNote?.tone !== 'ok' && (
                <PaymentIssueForm
                  onReport={(type, comment) => reportIssueFor(orderId, type, comment)}
                  onSent={(duplicate) => setIssueNote({ tone: 'ok', text: paymentIssueSentText(duplicate) })}
                  onError={(message) => setIssueNote({ tone: 'err', text: message })}
                />
              )}
            </div>
          </Sheet>
        );
      }
    }
  }
}

/**
 * Заголовок листа заказа (тикет 05): «ChatGPT Plus» и «Подписка на месяц ·
 * $20». Тариф известен, только если заказ создан в этом же листе из каталога;
 * у заказа из «Ждут оплаты» — название сервиса и доллары.
 */
function orderSheetTitle(
  detail: OrderDetail | null,
  hint: OrderHint | null,
): { title: string; subtitle: string | undefined } {
  if (!detail) return { title: 'Заказ', subtitle: undefined };
  const usdCents =
    detail.originalCurrency === 'USD' && detail.originalAmount !== null && detail.originalAmount > 0
      ? detail.originalAmount
      : hint?.usdCents ?? null;
  const usd = usdCents !== null ? formatUsd(usdCents) : null;
  if (hint?.tierName && hint.period) {
    return {
      title: `${detail.service} ${hint.tierName}`,
      subtitle: `Подписка на ${formatTierPeriod(hint.period)}${usd ? ` · ${usd}` : ''}`,
    };
  }
  return {
    title: detail.service,
    subtitle: usd ? `${usd} — столько спишет сервис` : undefined,
  };
}

function CenteredNote({ title, text }: { title?: string; text: string }) {
  return (
    <div className="mx-auto flex min-h-[60vh] w-full max-w-md flex-col items-center justify-center gap-2 p-6 text-center">
      {title && <h1 className="font-display text-xl font-bold text-[var(--text)]">{title}</h1>}
      <p className="font-body text-sm text-[var(--text-muted)]">{text}</p>
    </div>
  );
}
