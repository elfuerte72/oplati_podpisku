import 'server-only';

import * as Sentry from '@sentry/nextjs';

import { onDbChange, type DbChangeTable } from '@oplati/db';

import { childLogger } from '@/lib/logger';

import { isMenuBadgeSection, type MenuBadgeSection } from './desk';
import { invalidateMenuCounts } from './menu-counts';

/**
 * Хаб живых событий панели (трек panel-live): репозитории `@oplati/db`
 * сообщают «таблица изменилась», хаб переводит таблицу в разделы панели,
 * сбрасывает памятку счётчиков меню и раздаёт событие открытым SSE-потокам
 * (`GET /api/panel/events`).
 *
 * Здесь нет данных — только имена разделов: клиент по событию перерисовывает
 * СВОЮ страницу через `router.refresh()`, а второго способа получить те же
 * данные (который неизбежно разъедется с первым) не появляется.
 *
 * Инварианты:
 *   - события СКЛЕИВАЮТСЯ окном `PANEL_LIVE_COALESCE_MS`: одна оплата — это
 *     переход заказа, claim платежа и событие журнала за миллисекунды, и три
 *     перерисовки вместо одной никому не нужны; заодно окно даёт транзакции
 *     репозитория время закоммититься — лента сообщает о ЗАПИСИ, не о коммите;
 *   - памятка счётчиков сбрасывается СРАЗУ по разделам с бейджем — к моменту
 *     перерисовки число обязано быть свежим, иначе клиент увидит старый бейдж
 *     на фоне новой таблицы;
 *   - слушатель базы ставится первым подписчиком и снимается последним:
 *     без открытых потоков хаб не стоит ничего;
 *   - упавший подписчик не глушит остальных и не роняет запись в базу —
 *     ошибка уходит в Sentry;
 *   - состояние живёт в `globalThis`: при HMR модуль грузится дважды, и
 *     подписка одного экземпляра иначе не видела бы ленту другого.
 */

const log = childLogger('panel.live');

export const PANEL_LIVE_COALESCE_MS = 300;

/** Разделы, о которых панель хочет знать «что-то изменилось». */
export type PanelLiveSection = MenuBadgeSection | 'orders';

/**
 * Таблица → разделы. Заказ виден на столе, в списках «Все заказы», «Ждут
 * оплаты» и «Проверка платежей»; платёж — в «Ждут оплаты» (счёт) и в
 * «Проверке платежей» (холд); разговор и сообщения — в «Поддержке»; ответы на
 * опросы — в «Обратной связи».
 */
export const PANEL_LIVE_SECTIONS_BY_TABLE: Record<DbChangeTable, readonly PanelLiveSection[]> = {
  orders: ['orders', 'pending', 'holds'],
  payments: ['pending', 'holds'],
  conversations: ['support'],
  messages: ['support'],
  client_feedback: ['feedback'],
};

export type PanelLiveEvent = { sections: readonly PanelLiveSection[] };

export type PanelLiveListener = (event: PanelLiveEvent) => void;

type HubState = {
  subscribers: Set<PanelLiveListener>;
  offDb: (() => void) | null;
  pending: Set<PanelLiveSection>;
  timer: ReturnType<typeof setTimeout> | null;
};

const HUB_KEY = Symbol.for('oplati.panel.live-events');

function hub(): HubState {
  const g = globalThis as { [HUB_KEY]?: HubState };
  g[HUB_KEY] ??= { subscribers: new Set(), offDb: null, pending: new Set(), timer: null };
  return g[HUB_KEY];
}

function flush(state: HubState): void {
  state.timer = null;
  if (state.pending.size === 0) return;
  const event: PanelLiveEvent = { sections: [...state.pending].sort() };
  state.pending.clear();
  for (const listener of state.subscribers) {
    try {
      listener(event);
    } catch (err) {
      log.warn({ event: 'panel.live.listener_failed', err });
      Sentry.captureException(err, { tags: { source: 'panel.live' } });
    }
  }
}

function onTableChanged(state: HubState, table: DbChangeTable): void {
  const sections = PANEL_LIVE_SECTIONS_BY_TABLE[table];
  for (const section of sections) {
    state.pending.add(section);
    if (isMenuBadgeSection(section)) invalidateMenuCounts(section);
  }
  state.timer ??= setTimeout(() => flush(state), PANEL_LIVE_COALESCE_MS);
}

/** Подписаться на события панели; возвращает отписку. */
export function subscribePanelLive(listener: PanelLiveListener): () => void {
  const state = hub();
  state.subscribers.add(listener);
  state.offDb ??= onDbChange((change) => onTableChanged(state, change.table), {
    onError: (err) => {
      log.warn({ event: 'panel.live.db_listener_failed', err });
      Sentry.captureException(err, { tags: { source: 'panel.live' } });
    },
  });

  return () => {
    state.subscribers.delete(listener);
    if (state.subscribers.size > 0) return;
    state.offDb?.();
    state.offDb = null;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    state.pending.clear();
  };
}
