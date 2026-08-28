import 'server-only';

import {
  findCardsByUserIdForCabinet,
  getDb,
  getOrdersByUserId,
  getServicesByIds,
  searchActiveServices,
} from '@oplati/db';
import type { SupportServiceInstructions, SupportToolHandlers } from '@oplati/agent';

import { formatRub } from '@/components/comic/format';

import { ORDER_STATUS_LABELS, isPayableStatus } from '../cabinet/types';
import { childLogger } from '../logger';

/**
 * Read-only tools помощника (спека §6). Реализация интерфейса из
 * `@oplati/agent` — пакет агента БД не видит (граница пакетов).
 *
 * Результаты в КЛИЕНТСКИХ словах: статус берётся из ТОГО ЖЕ словаря, что
 * показывает кабинет (`ORDER_STATUS_LABELS`), сумма форматируется тем же
 * `formatRub`. Свой словарь здесь был бы зеркалом, а идентификатор статуса в
 * результате — утечкой, которую потом ловил бы выходной фильтр.
 */

const log = childLogger('support.tools');

/** Сколько заказов показываем модели: свежих хватает, история за год не нужна. */
const ORDERS_LIMIT = 5;

// Без `try`: Node с полным ICU (официальный образ) эти вызовы не роняет, а
// проглоченная ошибка форматирования прятала бы сломанную сборку без ICU.
function formatDeadline(date: Date): string {
  return date.toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDate(date: Date): string {
  return date.toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long' });
}

export type SupportToolsContext = {
  userId: string;
  /** Эскалация — из модуля поддержки, чтобы tool и жёсткий триггер шли одним путём. */
  requestHuman: (reason: string) => Promise<{ acknowledged: true }>;
  now?: Date;
};

export function createSupportToolHandlers(ctx: SupportToolsContext): SupportToolHandlers {
  const now = () => ctx.now ?? new Date();

  return {
    // ⚠️ `userId` — ТОЛЬКО из контекста. Модель не может передать чужой id:
    // его нет во входе tool'а, а значит нет и способа выдать чужие заказы.
    get_my_orders: async () => {
      const db = getDb();
      const orders = await getOrdersByUserId(db, ctx.userId, ORDERS_LIMIT);
      if (orders.length === 0) return [];

      const serviceIds = [...new Set(orders.map((o) => o.serviceId).filter((id): id is string => !!id))];
      const [services, cards] = await Promise.all([
        serviceIds.length > 0 ? getServicesByIds(db, serviceIds) : Promise.resolve([]),
        // Карты — выборкой КАБИНЕТА: только свои, только живые. Карта, ушедшая
        // в рецикл другому клиенту, прежнему владельцу не показывается даже
        // маской.
        findCardsByUserIdForCabinet(db, ctx.userId),
      ]);
      const serviceName = new Map(services.map((s) => [s.id, s.name]));
      const cardMask = new Map(cards.map((c) => [c.id, c.panMasked]));

      log.info({ event: 'support.tools.get_my_orders', userId: ctx.userId, count: orders.length });

      return orders.map((o) => ({
        number: o.shortId,
        service: (o.serviceId ? serviceName.get(o.serviceId) : null) ?? o.customServiceDescription ?? 'Заказ',
        amount: o.amountRub !== null ? formatRub(o.amountRub) : null,
        status: ORDER_STATUS_LABELS[o.status],
        // Срок называем только там, где он что-то значит для клиента: до
        // какого времени живёт счёт или фиксация. У завершённого заказа
        // «истекает» ничего не значит и только путает.
        validUntil:
          isPayableStatus(o.status) && o.expiresAt && o.expiresAt.getTime() > now().getTime()
            ? formatDeadline(o.expiresAt)
            : null,
        card: o.cardId ? (cardMask.get(o.cardId) ?? null) : null,
        createdAt: formatDate(o.createdAt),
      }));
    },

    get_service_instructions: async ({ query }) => {
      const db = getDb();
      const found = await searchActiveServices(db, query, log);
      const first = found[0];
      if (!first) return { notFound: true, query };

      const [service] = await getServicesByIds(db, [first.id]);
      const pi = service?.paymentInstructions ?? null;
      // Сервис есть, а инструкции нет — это «нет инструкции», а не пустой
      // объект: модель на пустом объекте сочинит инструкцию сама.
      if (!pi) return { notFound: true, query };

      const view: SupportServiceInstructions = {
        service: first.name,
        requiresVpn: pi.requiresVpn,
        vpnLocation: pi.vpnLocation ?? null,
        currency: pi.requiredCurrency ?? null,
        billing: pi.billingInstructions ?? null,
        // ⚠️ `paymentUrl` НЕ отдаём: модели он не нужен, а клиенту его даст
        // приложение — там же, где и кнопка оплаты.
        notes: pi.paymentNotes ?? null,
      };
      return view;
    },

    search_catalog: async ({ query }) => await searchActiveServices(getDb(), query, log),

    request_human: async ({ reason }) => await ctx.requestHuman(reason),
  };
}
