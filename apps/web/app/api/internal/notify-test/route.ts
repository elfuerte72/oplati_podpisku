import { NextResponse } from 'next/server';

import { notifyPaymentConfirmed } from '@/lib/jobs/notify-payment';
import { authorizeCron } from '@/app/api/cron/poll-payment/route';

/**
 * ВРЕМЕННЫЙ endpoint — разово дослать уведомление «оплата получена» за уже
 * оплаченный заказ ORD-P8S1F (пользователь заплатил до появления фичи).
 * Захардкожен на один orderId, защита как у cron'ов (на preview открыт).
 *
 * УДАЛИТЬ после проверки — не должен попасть в prod.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const preferredRegion = 'fra1';
export const maxDuration = 30;

const ORD_P8S1F = 'f4d218b4-29a1-4675-bef4-f7486dcff6ac';

export async function GET(req: Request): Promise<NextResponse> {
  if (!authorizeCron(req)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  await notifyPaymentConfirmed(ORD_P8S1F);
  return NextResponse.json({ ok: true, notified: ORD_P8S1F });
}
