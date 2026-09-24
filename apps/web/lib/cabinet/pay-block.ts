/**
 * Чего не хватает, чтобы выставить счёт (трек miniapp-tabs, тикет 05).
 *
 * Раньше кнопка «Оплатить» без почты была просто серой — и все семь клиентов,
 * не дошедших до счёта, не заполнили почту (находка П8 разбора). Теперь кнопка
 * активна всегда, а нажатие без контактов называет недостающее поле и ведёт к
 * нему. Сами гейты — на сервере (`email_required` / `phone_required` в
 * `payments/create`), здесь только подсказка до запроса.
 */

export type PayBlockReason = 'email' | 'phone';

export const PAY_BLOCK_TEXT: Record<PayBlockReason, string> = {
  email: 'Укажи почту — без неё не выставим счёт',
  phone: 'Укажи телефон — для этой суммы без него не выставим счёт',
};

/** Почта раньше телефона: она стоит выше на экране, к ней и ведём первой. */
export function payBlockReason(input: {
  emailOk: boolean;
  phoneRequired: boolean;
  phoneOk: boolean;
}): PayBlockReason | null {
  if (!input.emailOk) return 'email';
  if (input.phoneRequired && !input.phoneOk) return 'phone';
  return null;
}
