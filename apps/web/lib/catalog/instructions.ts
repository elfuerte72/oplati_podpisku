import type { ServicePaymentInstructions } from '@oplati/types';

/**
 * Сборка человекочитаемых пунктов «Важно перед оплатой» из пер-сервисных
 * правил оплаты (`services.payment_instructions`, ТЗ «клиентский путь» §5).
 * Чистые функции — общие для веб-чата, Mini App и тестов.
 */

/**
 * Generic-подсказка для сервисов без записи payment_instructions. Страну
 * выпуска карты публично не указываем (ТЗ §2) — только локацию VPN.
 */
export const GENERIC_INSTRUCTION_TEXT =
  'Платим виртуальной картой без НДС. Включи на сайте сервиса VPN с локацией ' +
  'США — иначе из-за локации спишется больше (например, подписка $100 обойдётся в $111).';

/** Предупреждение из ТЗ §5 — показывается, когда сервису нужен VPN. */
export const VPN_WARNING_TEXT =
  'Иначе сумма может отличаться и платёж не пройдёт.';

/**
 * Пункты инструкции конкретного сервиса, в порядке важности. Пустой массив не
 * возвращается никогда: у сервиса без VPN появляется явный пункт «VPN не нужен».
 */
export function instructionPoints(instructions: ServicePaymentInstructions): string[] {
  const points: string[] = [];

  if (instructions.requiresVpn) {
    points.push(
      instructions.vpnLocation
        ? `Включи VPN с локацией ${instructions.vpnLocation}.`
        : 'Включи VPN перед оплатой.',
    );
  } else {
    points.push('VPN для оплаты не нужен.');
  }

  if (instructions.requiredCurrency) {
    points.push(
      `Проверь, что цена на сайте сервиса отображается в ${instructions.requiredCurrency}.`,
    );
  }

  if (instructions.billingInstructions) {
    points.push(instructions.billingInstructions);
  }

  if (instructions.paymentNotes) {
    points.push(instructions.paymentNotes);
  }

  return points;
}
