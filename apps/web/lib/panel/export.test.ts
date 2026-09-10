import { describe, expect, it } from 'vitest';

import { EXPORT_COLUMNS } from './labels';
import { exportOrderRow, formatRublesForCsv } from './export';

/**
 * Что именно уезжает в файле. Выгрузка — единственное место панели, откуда
 * данные уходят наружу, поэтому её состав проверяется утверждением.
 */
const order = {
  id: 'o1',
  shortId: 'ORD-WX7S4',
  status: 'completed' as const,
  amountRubKopecks: 367200,
  bonusDiscountKopecks: 0,
  createdAt: new Date('2026-09-02T14:34:00Z'),
  expiresAt: null,
  serviceName: 'HeyGen',
  client: { id: 'u1', displayName: 'Алинка', telegramId: '77', email: 'a@b.c' },
  assignedOperatorName: 'Менеджер',
};

describe('exportOrderRow', () => {
  it('колонок в строке столько же, сколько в заголовке', () => {
    // Разъезд заголовка и строки сдвигает ВСЕ значения на колонку вправо, и
    // почта клиента оказывается в графе «создан».
    expect(exportOrderRow(order)).toHaveLength(EXPORT_COLUMNS.orders.length);
  });

  it('статус — словом, а не кодом', () => {
    expect(exportOrderRow(order)[1]).toBe('Выполнен');
  });

  it('сумма — в рублях с копейками', () => {
    // Колонка «367200» вместо «3672,00» даёт неверный итог при сложении, и об
    // этом никто не догадается.
    expect(exportOrderRow(order)[3]).toBe('3672,00');
  });

  it('время — ISO, а не местное', () => {
    // Файл читают в разных местах: «02.09.26, 14:34» без зоны означает разное
    // время у разных людей.
    expect(exportOrderRow(order)[8]).toBe('2026-09-02T14:34:00.000Z');
  });

  it('погашение баллами — отдельная колонка, а не вычет из суммы', () => {
    // В таблице складывают обе колонки: выручка деньгами должна считаться без
    // ручной арифметики, а «сколько отдали баллами» — видеться отдельно.
    const row = exportOrderRow({ ...order, bonusDiscountKopecks: 28_600 });

    expect(row[3]).toBe('3672,00');
    expect(row[4]).toBe('286,00');
  });

  it('заказ без списания оставляет колонку пустой, а не «0,00»', () => {
    // Ноль в колонке денег читается как факт списания на ноль.
    expect(exportOrderRow(order)[4]).toBe('');
  });

  it('пустые поля остаются пустыми, а не превращаются в слова', () => {
    const row = exportOrderRow({
      ...order,
      serviceName: null,
      amountRubKopecks: null,
      assignedOperatorName: null,
      client: { id: 'u1', displayName: null, telegramId: null, email: null },
    });

    expect(row[2]).toBe('');
    expect(row[3]).toBe('');
    expect(row[5]).toBe('');
    expect(row[9]).toBe('');
  });
});

describe('formatRublesForCsv', () => {
  it('копейки не теряются и не округляются', () => {
    expect(formatRublesForCsv(367200)).toBe('3672,00');
    expect(formatRublesForCsv(1)).toBe('0,01');
    expect(formatRublesForCsv(90)).toBe('0,90');
    expect(formatRublesForCsv(0)).toBe('0,00');
  });

  it('нет суммы — пустая ячейка', () => {
    expect(formatRublesForCsv(null)).toBe('');
    expect(formatRublesForCsv(undefined)).toBe('');
  });
});
