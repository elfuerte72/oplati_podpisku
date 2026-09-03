import { describe, expect, it } from 'vitest';

import { CSV_BOM, buildCsv, csvCell, csvFilename, csvRow } from './csv';

/**
 * Сборка CSV. Проверяется в первую очередь то, что делает выгрузку опасной или
 * бесполезной: формула в имени клиента и кириллица без BOM.
 */
describe('csvCell', () => {
  it('обезвреживает формулу', () => {
    // Имя приходит из Telegram — его пишет посторонний человек, и такая
    // ячейка выполнится при открытии файла на машине сотрудника.
    expect(csvCell('=HYPERLINK("http://evil","клик")')).toBe(
      '"\'=HYPERLINK(""http://evil"",""клик"")"',
    );
    for (const starter of ['=', '+', '-', '@', '\t', '\r']) {
      expect(csvCell(`${starter}cmd`), starter).toContain(`'${starter}cmd`);
    }
  });

  it('число не превращается в текст, даже отрицательное', () => {
    // `'-500,00` в таблице становится текстом, и колонка сумм перестаёт
    // складываться — ровно та беда, ради которой суммы пишутся рублями.
    expect(csvCell('-500,00')).toBe('-500,00');
    expect(csvCell(-42)).toBe('-42');
    expect(csvCell('-1.5')).toBe('-1.5');
    // А вот это уже не число, а выражение — обезвреживаем.
    expect(csvCell('-1+2')).toBe("'-1+2");
  });

  it('кавычит то, что иначе разъедет таблицу', () => {
    expect(csvCell('Иванов; Пётр')).toBe('"Иванов; Пётр"');
    expect(csvCell('строка\nвторая')).toBe('"строка\nвторая"');
    expect(csvCell('он сказал "да"')).toBe('"он сказал ""да"""');
  });

  it('пустое значение — пустая ячейка, а не слово null', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(0)).toBe('0');
  });

  it('обычный текст не трогает', () => {
    expect(csvCell('ORD-WX7S4')).toBe('ORD-WX7S4');
    expect(csvCell(3672)).toBe('3672');
  });
});

describe('csvRow', () => {
  it('разделитель — точка с запятой', () => {
    // Запятая в русской локали Excel — десятичный разделитель, и файл с ней
    // ложится в одну колонку.
    expect(csvRow(['a', 'b', null])).toBe('a;b;');
  });
});

describe('buildCsv', () => {
  it('начинается с BOM и разделяет строки CRLF', () => {
    const csv = buildCsv(['Заказ', 'Сумма'], [['ORD-1', 100]]);

    expect(csv.startsWith(CSV_BOM)).toBe(true);
    expect(csv).toBe(`${CSV_BOM}Заказ;Сумма\r\nORD-1;100\r\n`);
  });

  it('пустая выгрузка остаётся файлом с заголовком', () => {
    // Пустой файл неотличим от сломанной выгрузки; заголовок говорит, что
    // выгрузка прошла и строк просто нет.
    expect(buildCsv(['Заказ'], [])).toBe(`${CSV_BOM}Заказ\r\n`);
  });
});

describe('csvFilename', () => {
  it('называет раздел и дату', () => {
    expect(csvFilename('orders', new Date('2026-09-03T10:00:00Z'))).toBe(
      'oplatishka-orders-2026-09-03.csv',
    );
  });
});
