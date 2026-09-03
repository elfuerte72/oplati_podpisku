/**
 * Сборка CSV для выгрузок панели (v3).
 *
 * ⚠️ Две вещи, без которых выгрузка становится хуже, чем её отсутствие:
 *
 * 1. **Ячейка, начинающаяся с `=`, `+`, `-`, `@`, — формула.** Имя клиента
 *    приходит из Telegram, то есть его пишет посторонний человек, и
 *    `=HYPERLINK(...)` в выгрузке выполнится на машине сотрудника при открытии
 *    файла. Такие ячейки предваряются апострофом.
 * 2. **Excel читает CSV в системной кодировке.** Без BOM кириллица
 *    открывается кракозябрами, и первое, что делает человек, — закрывает файл.
 *
 * Разделитель — точка с запятой: в русской локали Excel и Numbers запятая
 * означает десятичный разделитель, и файл с ней ложится в одну колонку.
 */

/** Символ, с которого таблица начинает видеть формулу. */
const FORMULA_STARTERS = ['=', '+', '-', '@', '\t', '\r'];

/**
 * Целое или дробное число (в том числе с запятой и минусом). Такая ячейка НЕ
 * обезвреживается: `'-500,00` в таблице становится текстом, и колонка сумм
 * перестаёт складываться — ровно та беда, ради которой суммы пишутся рублями.
 */
const NUMERIC_RE = /^-?\d+(?:[.,]\d+)?$/;

export const CSV_DELIMITER = ';';

/**
 * BOM: без него Excel открывает кириллицу кракозябрами. Задан кодом, а не
 * невидимым символом в литерале: инструмент, чистящий BOM в исходниках, убрал
 * бы его молча вместе с кириллицей в выгрузке.
 */
export const CSV_BOM = '\uFEFF';

/**
 * Одна ячейка: обезвреженная и, если нужно, закавыченная.
 *
 * `null` и `undefined` дают пустую ячейку, а не строку «null»: пустое поле в
 * таблице читается как «нет значения», слово `null` — как значение.
 */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';

  let text = String(value);
  // Минус — стартер формулы, но отрицательная сумма формулой не является:
  // см. `NUMERIC_RE`.
  if (!NUMERIC_RE.test(text) && text.length > 0 && FORMULA_STARTERS.includes(text[0] ?? '')) {
    text = `'${text}`;
  }

  // Кавычим всё, что иначе разъедет строку или колонку.
  if (/[";\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function csvRow(cells: readonly (string | number | null | undefined)[]): string {
  return cells.map(csvCell).join(CSV_DELIMITER);
}

/**
 * Готовый файл: BOM, заголовок, строки. Переводы строк — CRLF (RFC 4180;
 * старые версии Excel на одном LF склеивают строки).
 */
export function buildCsv(
  header: readonly string[],
  rows: readonly (readonly (string | number | null | undefined)[])[],
): string {
  return CSV_BOM + [csvRow(header), ...rows.map(csvRow)].join('\r\n') + '\r\n';
}

/**
 * Имя файла выгрузки: раздел и дата, чтобы в папке «Загрузки» они не
 * назывались `export (3).csv`.
 */
export function csvFilename(section: string, now: Date): string {
  const date = now.toISOString().slice(0, 10);
  return `oplatishka-${section}-${date}.csv`;
}
