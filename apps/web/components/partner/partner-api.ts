'use client';

import type { ReferralSnapshot } from '@/lib/cabinet/referral-types';

/**
 * Клиент `/api/cabinet/referral` — переиспользуется обеими поверхностями:
 * сайт `/partner` (auth по cookie, `initData` опускается) и секция мини-аппа
 * (передаёт `initData`). Никаких токенов на клиенте — авторизация в роуте.
 */

export type SnapshotResult =
  | { ok: true; snapshot: ReferralSnapshot }
  | { ok: false; error: string; status: number };

export type PayoutResult =
  | { ok: true; payoutId: string; amountUsdCents: number }
  | { ok: false; error: string; minPayoutUsdCents?: number; balanceUsdCents?: number };

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

export async function fetchReferralSnapshot(initData?: string): Promise<SnapshotResult> {
  const { status, json } = await postReferral({
    action: 'snapshot',
    ...(initData ? { initData } : {}),
  });
  const body = json as { ok?: boolean; snapshot?: ReferralSnapshot; error?: string } | null;
  if (body?.ok && body.snapshot) {
    return { ok: true, snapshot: body.snapshot };
  }
  return { ok: false, error: body?.error ?? 'unknown', status };
}

export async function requestPayout(amountUsdCents: number, initData?: string): Promise<PayoutResult> {
  const { json } = await postReferral({
    action: 'payout',
    amountUsdCents,
    ...(initData ? { initData } : {}),
  });
  const body = json as PayoutResult | null;
  if (body && 'ok' in body) return body;
  return { ok: false, error: 'unknown' };
}
