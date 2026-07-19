'use client';

import type { ReferralSnapshot } from '@/lib/cabinet/referral-types';
import {
  referralErrorResponseSchema,
  referralPayoutResponseSchema,
  referralSnapshotResponseSchema,
  type ReferralPayoutResponse,
} from '@/lib/cabinet/referral-api-schemas';

/**
 * Клиент `/api/cabinet/referral` — переиспользуется обеими поверхностями:
 * сайт `/partner` (auth по cookie, `initData` опускается) и секция мини-аппа
 * (передаёт `initData`). Никаких токенов на клиенте — авторизация в роуте.
 * Ответы парсятся Zod-схемами из `referral-api-schemas` (M-9 аудита: раньше
 * здесь были `as`-касты при том, что близнец `cabinet-api.ts` парсит схемами).
 */

export type SnapshotResult =
  | { ok: true; snapshot: ReferralSnapshot }
  | { ok: false; error: string; status: number };

export type PayoutResult = ReferralPayoutResponse;

async function postReferral(body: Record<string, unknown>): Promise<{ status: number; json: unknown }> {
  const res = await fetch('/api/cabinet/referral', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

/** Код ошибки из тела ответа; `unknown`, если тело не наш контракт. */
function errorCode(json: unknown): string {
  const parsed = referralErrorResponseSchema.safeParse(json);
  return parsed.success ? parsed.data.error : 'unknown';
}

export async function fetchReferralSnapshot(initData?: string): Promise<SnapshotResult> {
  const { status, json } = await postReferral({
    action: 'snapshot',
    ...(initData ? { initData } : {}),
  });
  const parsed = referralSnapshotResponseSchema.safeParse(json);
  if (parsed.success) {
    return { ok: true, snapshot: parsed.data.snapshot };
  }
  return { ok: false, error: errorCode(json), status };
}

export async function requestPayout(amountUsdCents: number, initData?: string): Promise<PayoutResult> {
  const { json } = await postReferral({
    action: 'payout',
    amountUsdCents,
    ...(initData ? { initData } : {}),
  });
  const parsed = referralPayoutResponseSchema.safeParse(json);
  if (parsed.success) return parsed.data;
  return { ok: false, error: errorCode(json) };
}
