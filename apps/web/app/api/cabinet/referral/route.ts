import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { payoutDestinationInputSchema } from '@oplati/types';

import { serverEnv } from '@/lib/env.server';
import { childLogger } from '@/lib/logger';
import { checkRateLimit } from '@/lib/ratelimit';
import { getBotUsername } from '@/lib/telegram/bot';
import { resolveReferralRequester } from '@/lib/cabinet/referral-auth';
import { buildReferralSnapshot, type ReferralSnapshotContext } from '@/lib/cabinet/referral-read';
import { requestReferralPayout } from '@/lib/cabinet/referral-actions';

/**
 * POST /api/cabinet/referral — бэкенд партнёрского кабинета. Обслуживает обе
 * поверхности: сайт `/partner` (auth по cookie-сессии) и секцию мини-аппа (auth
 * по `initData`). Как и `/api/cabinet`, это НЕ webhook — отдаём настоящие
 * статус-коды (401/429/200).
 *
 * Тело: `{ action: 'snapshot' | 'payout', initData?, amountUsdCents? }`.
 * `initData` есть → путь мини-аппа; нет → веб-сессия. POST (не GET), т.к.
 * `initData` нельзя класть в URL — единый контракт с существующим кабинетом.
 *
 * Гейт `REFERRAL_ENABLED`: выключенная программа отдаёт «спящий» снапшот и
 * отклоняет выплаты, НЕ создавая строк (резолв личности — только при enabled).
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const preferredRegion = 'fra1';
export const maxDuration = 60;

const log = childLogger('referral-cabinet-api');

const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('snapshot'), initData: z.string().min(1).optional() }),
  z.object({
    action: z.literal('payout'),
    initData: z.string().min(1).optional(),
    amountUsdCents: z.number().int().positive(),
    // Реквизиты (Этап E). Опциональны, пока форма реквизитов не подключена и способ
    // выплат не выбран (D-REF-6). Полный PAN валидируется, но не хранится (маскируется).
    destination: payoutDestinationInputSchema.optional(),
  }),
]);

const RATE_LIMITED_TEXT = 'Слишком много запросов подряд. Подожди минутку и попробуй снова.';

function baseUrl(): string {
  return serverEnv.APP_URL.replace(/\/+$/, '');
}

/** Username бота для deep-link — graceful: при сбое ссылка в TG просто опустится. */
async function resolveBotUsername(): Promise<string | null> {
  try {
    return await getBotUsername();
  } catch (err) {
    log.warn({ event: 'referral.cabinet.bot_username_failed', err });
    return null;
  }
}

export async function POST(req: Request): Promise<NextResponse> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }

  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: 'invalid_body' }, { status: 400 });
  }
  const body = parsed.data;

  // ── Гейт: программа выключена ──
  if (!serverEnv.REFERRAL_ENABLED) {
    if (body.action === 'payout') {
      return NextResponse.json({ ok: false, error: 'disabled' }, { status: 200 });
    }
    // Спящий снапшот без резолва личности и без записи в БД.
    const ctx: ReferralSnapshotContext = {
      enabled: false,
      telegramLinked: false,
      baseUrl: baseUrl(),
      botUsername: null,
      minPayoutUsdCents: serverEnv.REFERRAL_MIN_PAYOUT_USD_CENTS,
    };
    const snapshot = await buildReferralSnapshot('', ctx);
    return NextResponse.json({ ok: true, snapshot }, { status: 200 });
  }

  // ── Авторизация (мини-апп initData ИЛИ веб-сессия) ──
  const auth = await resolveReferralRequester(body.initData);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }
  const { userId, telegramLinked, rateLimit } = auth.requester;

  // ── Per-identity rate-limit ──
  const rl = await checkRateLimit(rateLimit.name, rateLimit.id);
  if (!rl.allowed) {
    log.warn({ event: 'referral.cabinet.rate_limited', action: body.action });
    return NextResponse.json(
      { ok: false, error: 'rate_limited', text: RATE_LIMITED_TEXT },
      { status: 429 },
    );
  }

  try {
    switch (body.action) {
      case 'snapshot': {
        const ctx: ReferralSnapshotContext = {
          enabled: true,
          telegramLinked,
          baseUrl: baseUrl(),
          botUsername: await resolveBotUsername(),
          minPayoutUsdCents: serverEnv.REFERRAL_MIN_PAYOUT_USD_CENTS,
        };
        const snapshot = await buildReferralSnapshot(userId, ctx);
        return NextResponse.json({ ok: true, snapshot }, { status: 200 });
      }
      case 'payout': {
        const result = await requestReferralPayout({
          userId,
          telegramLinked,
          amountUsdCents: body.amountUsdCents,
          destination: body.destination ?? null,
        });
        return NextResponse.json(result, { status: 200 });
      }
    }
  } catch (err) {
    log.error({ event: 'referral.cabinet.dispatch_failed', action: body.action, err });
    Sentry.captureException(err, { tags: { source: 'referral-cabinet-api', action: body.action } });
    return NextResponse.json({ ok: false, error: 'internal_error' }, { status: 500 });
  }
}
