'use client';

/**
 * Выпадающий список фильтра — часть формы поиска, а не отдельный виджет.
 *
 * Зачем список вместо полосы кнопок: на экране заказов их было три —  статус
 * (6 кнопок), сортировка (4) и период (4), четырнадцать одинаковых плашек
 * подряд. Статус остался кнопками (это главный срез, им пользуются постоянно),
 * а сортировка и период уехали сюда: их меняют редко, и место они занимали
 * наравне с самым частым переключателем.
 *
 * ⚠️ Список живёт ВНУТРИ формы поиска и подписан `name`, поэтому без единой
 * строки скрипта работает так: сменил значение → нажал «Найти». Обработчик
 * ниже лишь избавляет от второго действия. Ключи адреса не меняются —
 * пересланная коллеге ссылка значит то же самое.
 */
export function PanelFilterSelect({
  name,
  value,
  options,
  label,
}: {
  /** Имя поля формы — оно же ключ адреса (`sort`, `period`). */
  name: string;
  value: string;
  options: readonly { value: string; title: string }[];
  /** Доступное имя: видимой подписи у списка нет, её заменяет текущее значение. */
  label: string;
}) {
  return (
    <select
      className="panel-select"
      name={name}
      defaultValue={value}
      aria-label={label}
      onChange={(event) => event.currentTarget.form?.requestSubmit()}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.title}
        </option>
      ))}
    </select>
  );
}
