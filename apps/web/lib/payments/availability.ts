import { isFreekassaUnavailable } from '../freekassa/availability.ts';
import { isPaymentProviderUnavailable } from '../loveandpay/availability.ts';

/**
 * Провайдер-агностичный детектор «приём оплаты недоступен из-за транспорта».
 *
 * `payments/create` с этапа 3 умеет ходить в два шлюза, а пользовательский
 * ответ («технический сбой, заказ сохранён, попробуй позже») и статус
 * `503 provider_unavailable` должны быть одинаковыми независимо от того, кто
 * сейчас основной. Развилку по типам ошибок держим в одном месте, чтобы
 * добавление третьего провайдера не требовало ревизии всех call-site'ов.
 *
 * Текст для клиента — общий `PROVIDER_UNAVAILABLE_TEXT` (там же, где был).
 */
export function isPaymentGatewayUnavailable(err: unknown): boolean {
  return isPaymentProviderUnavailable(err) || isFreekassaUnavailable(err);
}
