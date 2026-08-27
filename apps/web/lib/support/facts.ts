import 'server-only';

import { CARD_LIFETIME_DAYS } from '@oplati/types';
import type { SupportFacts } from '@oplati/agent';

import { serverEnv } from '@/lib/env.server';
import { currentInvoiceTtlHours } from '@/lib/payments/gateway';
import { OPERATOR_HOURS } from '@/lib/telegram/templates';
import { PRICE_LOCK_TTL_HOURS } from '@/lib/tool-handlers/propose-order';

/**
 * Динамические факты для базы знаний помощника (спека §5).
 *
 * ⚠️ Каждое число берётся ОТТУДА, ГДЕ ИМ ПОЛЬЗУЕТСЯ КОД, а не переписывается
 * сюда. Иначе это зеркало (инвариант 10) худшего сорта: расхождение ничего не
 * ломает и никуда не пишется — помощник просто начинает уверенно называть
 * клиенту неверный срок или неверную надбавку, и узнаём мы об этом от клиента.
 */
export function collectSupportFacts(): SupportFacts {
  return {
    cardIssueFeeUsdCents: serverEnv.CARD_ISSUE_FEE_USD_CENTS,
    cardLifetimeDays: CARD_LIFETIME_DAYS,
    priceLockHours: PRICE_LOCK_TTL_HOURS,
    invoiceTtlHours: currentInvoiceTtlHours(),
    operatorHours: {
      fromHour: OPERATOR_HOURS.fromHour,
      toHour: OPERATOR_HOURS.toHour,
      tzLabel: 'МСК',
    },
    phoneRequiredFromRub: serverEnv.PHONE_REQUIRED_FROM_RUB ?? null,
  };
}
