import 'server-only';

import * as Sentry from '@sentry/nextjs';

import { getDb, reverseAccrualsForOrder } from '@oplati/db';

import { childLogger } from '@/lib/logger';

const log = childLogger('referral-reverse');

/**
 * Отмена реферальных начислений заказа, провалившегося ПОСЛЕ оплаты (R-1).
 *
 * Зеркало `accrueReferralForPayment`: тот начисляет на переходе в `paid`, этот
 * гасит на переходе в `failed`. Комиссия платится из маржи исполненного заказа;
 * у провалившегося маржи нет, а деньги клиенту возвращаются.
 *
 * Graceful по той же причине, что и начисление: сбой ledger'а НЕ должен сорвать
 * основной путь. Здесь цена ошибки даже выше — вызов стоит в `markOrderFailed`,
 * и проброшенное исключение оставило бы заказ в `paid`/`in_fulfillment`, то есть
 * в статусе, из которого его уже никто не заберёт. Бэкстоп на пропуски —
 * сверка в cron `referral-recovery`.
 *
 * ⚠️ Гейта `REFERRAL_ENABLED` здесь НЕТ намеренно (находка ревью), в отличие от
 * начисления. Флаг — аварийный выключатель программы, а отмена только УМЕНЬШАЕТ
 * наши обязательства: с гейтом выключение флага означало бы, что начисления,
 * записанные при включённом, продолжают оплачиваться по провалившимся заказам.
 * Гасить безопасно всегда; когда программа выключена, гасить обычно нечего.
 *
 * ⚠️ Отмена ложится в месяц, когда произошла. Если заказ оплачен 31-го, а
 * провалился 1-го, месячный доход партнёра за новый месяц уйдёт в минус — это
 * честное отражение возврата. График в кабинете такой месяц показывает явно
 * (подпись + другой цвет столбика): молча спрятать минус нельзя, иначе итог
 * сверху падает без видимой причины. Альтернатива (копировать `created_at`, как
 * делает гашение самореферала) хуже: она задним числом меняет уже показанную
 * партнёру цифру за закрытый месяц.
 *
 * @returns сколько строк погашено (0 — гасить было нечего или сбой)
 */
export async function reverseReferralAccrualsForFailedOrder(orderId: string): Promise<number> {
  try {
    const reversed = await reverseAccrualsForOrder(getDb(), orderId);
    if (reversed > 0) {
      log.info({ event: 'referral.reverse.applied', orderId, reversed });
    }
    return reversed;
  } catch (err) {
    log.error({ event: 'referral.reverse.failed', orderId, err });
    Sentry.captureException(err, {
      level: 'error',
      tags: { source: 'referral-reverse' },
      extra: { orderId },
    });
    return 0;
  }
}
