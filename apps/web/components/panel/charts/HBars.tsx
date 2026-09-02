/**
 * Горизонтальные столбцы — топы и воронка. Не SVG-полотно, а строки с полосой
 * на CSS: подпись слева, значение справа текстом, длина полосы — доля от
 * максимума. Так подписи никогда не режутся (они обычный текст с переносом), а
 * таблица остаётся доступной без картинки.
 *
 * Полоса — единственный цветной элемент строки; текст носит текстовые цвета,
 * не цвет данных (правило dataviz).
 */

export type HBarRow = {
  key: string;
  label: string;
  value: number;
  /** Значение текстом — форматирует вызывающий (деньги, люди, клики). */
  valueText: string;
  /** Пометка справа от значения: конверсия к предыдущему шагу, «есть ещё» и т.п. */
  note?: string | null;
};

export function HBars({ rows, title }: { rows: readonly HBarRow[]; title: string }) {
  const max = Math.max(0, ...rows.map((r) => r.value));
  return (
    <div className="panel-hbars" role="table" aria-label={title}>
      {rows.map((row) => {
        const share = max > 0 ? Math.max(0, Math.min(1, row.value / max)) : 0;
        return (
          <div className="panel-hbars__row" role="row" key={row.key}>
            <div className="panel-hbars__label" role="cell">
              {row.label}
            </div>
            <div className="panel-hbars__track" role="cell" title={`${row.label} — ${row.valueText}`}>
              <div
                className="panel-hbars__bar"
                style={{ width: `${(share * 100).toFixed(1)}%` }}
                aria-hidden="true"
              />
            </div>
            <div className="panel-hbars__value" role="cell">
              {row.valueText}
              {row.note !== undefined ? (
                <span className="panel-hbars__note">{row.note ?? '—'}</span>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
