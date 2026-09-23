/**
 * Копирование реквизита в листе «Реквизиты карты» (трек miniapp-tabs, тикеты
 * 07 и 10) — чистая часть без DOM: буфер и телеметрия приходят зависимостями.
 *
 * Исход честный: отказ буфера — `failed`, и экран показывает подсказку
 * «выдели и скопируй вручную», а не «Скопировано» (находка П11: прежний показ
 * глотал отказ, и клиент вставлял на сайт сервиса то, что лежало в буфере).
 *
 * ⚠️ В телеметрию уходит только ИМЯ поля и исход, значение — никогда.
 */
export type CardCopyField = 'number' | 'exp' | 'cvc' | 'address';

export async function copyCardField(
  input: { field: CardCopyField; value: string },
  deps: {
    copy: (text: string) => Promise<boolean>;
    track: (name: 'card_copy', props: { field: CardCopyField; ok: boolean }) => void;
  },
): Promise<'copied' | 'failed'> {
  const ok = await deps.copy(input.value);
  deps.track('card_copy', { field: input.field, ok });
  return ok ? 'copied' : 'failed';
}
