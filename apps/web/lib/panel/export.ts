import type { PanelOrderListItem } from '@oplati/db';

import { orderStatusLabel } from './format';

/**
 * Выгрузка списка в CSV (панель v3): сколько строк берём и что кладём в них.
 *
 * ⚠️ Строка выгрузки собирается ЗДЕСЬ, а не в роуте, потому что её проверяют
 * тестом: выгрузка — единственное место панели, откуда данные уезжают наружу
 * файлом, и «что именно уехало» должно быть утверждением, а не намерением.
 */

/** Размер страницы выборки. Тот же потолок, что у экрана. */
export const EXPORT_PAGE_SIZE = 100;

/**
 * Потолок выгрузки. Пять тысяч строк — это годы работы на нынешнем объёме и
 * секунды на сборку; предел стоит не ради размера файла, а чтобы забытый
 * фильтр не тянул всю таблицу в тот же процесс, что принимает деньги.
 */
export const EXPORT_MAX_ROWS = 5000;

/**
 * Строка выгрузки заказа.
 *
 * ⚠️ Деньги — В РУБЛЯХ с копейками, а не в копейках: файл открывают в таблице
 * и складывают, и колонка «367200» вместо «3672,00» даёт неверный итог, о
 * котором никто не догадается. Десятичный разделитель — запятая: в русской
 * локали Excel точка не считается числом.
 *
 * Даты — ISO без часового пояса браузера: файл читают в разных местах, и
 * «02.09.26, 14:34» без указания зоны означает разное время у разных людей.
 */
export function exportOrderRow(order: PanelOrderListItem): string[] {
  return [
    order.shortId,
    orderStatusLabel(order.status),
    order.serviceName ?? '',
    formatRublesForCsv(order.amountRubKopecks),
    order.client.displayName ?? '',
    order.client.telegramId ?? '',
    order.client.email ?? '',
    order.createdAt.toISOString(),
    order.assignedOperatorName ?? '',
  ];
}

/** Копейки → «3672,00». Пустая ячейка, если суммы нет вовсе. */
export function formatRublesForCsv(kopecks: number | null | undefined): string {
  if (kopecks === null || kopecks === undefined) return '';
  const sign = kopecks < 0 ? '-' : '';
  const abs = Math.abs(kopecks);
  return `${sign}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, '0')}`;
}
