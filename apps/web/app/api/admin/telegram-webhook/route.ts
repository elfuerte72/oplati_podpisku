import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { serverEnv } from '@/lib/env.server';
import { childLogger } from '@/lib/logger';
import { getBot } from '@/lib/telegram/bot';

/**
 * Админский endpoint управления Telegram webhook'ом текущего deployment'а.
 *
 *   POST   /api/admin/telegram-webhook   — setWebhook на указанный URL
 *   GET    /api/admin/telegram-webhook   — getWebhookInfo (текущее состояние)
 *   DELETE /api/admin/telegram-webhook   — deleteWebhook
 *
 * Защита: `X-Internal-Token` (тот же, что использует `confirm_order` →
 * `/api/payments/create`). Внутри сервера читаем `TELEGRAM_BOT_TOKEN` и
 * `TELEGRAM_WEBHOOK_SECRET` через серверный env — наружу токен не утекает.
 *
 * Используется при каждой смене preview-URL (новая ветка / новый branch alias)
 * чтобы перерегистрировать webhook без раскрытия токена в чате/curl'ах.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const preferredRegion = 'fra1';
export const maxDuration = 30;

const log = childLogger('admin.telegram-webhook');

const postBodySchema = z.object({
  url: z.string().url(),
  dropPendingUpdates: z.boolean().optional(),
});

function authorize(req: Request): boolean {
  const expected = serverEnv.INTERNAL_API_TOKEN;
  if (!expected) return false;
  return req.headers.get('x-internal-token') === expected;
}

export async function GET(req: Request): Promise<NextResponse> {
  if (!authorize(req)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  try {
    const info = await getBot().api.getWebhookInfo();
    log.info({ event: 'admin.telegram.get_webhook_info', url: info.url });
    return NextResponse.json({ ok: true, webhook: info });
  } catch (err) {
    log.error({ event: 'admin.telegram.get_webhook_info.failed', err });
    Sentry.captureException(err, { tags: { source: 'admin.telegram-webhook' } });
    return NextResponse.json(
      { ok: false, error: 'internal_error', message: (err as Error).message },
      { status: 500 },
    );
  }
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!authorize(req)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }

  const parsed = postBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        error: 'invalid_body',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
      { status: 400 },
    );
  }

  const secretToken = serverEnv.TELEGRAM_WEBHOOK_SECRET;
  if (!secretToken) {
    log.error({ event: 'admin.telegram.set_webhook.no_secret' });
    return NextResponse.json(
      { ok: false, error: 'TELEGRAM_WEBHOOK_SECRET не задан в env' },
      { status: 500 },
    );
  }

  try {
    const bot = getBot();
    await bot.api.setWebhook(parsed.data.url, {
      secret_token: secretToken,
      drop_pending_updates: parsed.data.dropPendingUpdates ?? false,
      allowed_updates: ['message'],
    });
    const info = await bot.api.getWebhookInfo();

    log.info({
      event: 'admin.telegram.set_webhook.ok',
      url: parsed.data.url,
      pendingUpdateCount: info.pending_update_count,
    });

    return NextResponse.json({
      ok: true,
      message: 'Webhook registered',
      webhook: info,
    });
  } catch (err) {
    log.error({ event: 'admin.telegram.set_webhook.failed', err });
    Sentry.captureException(err, { tags: { source: 'admin.telegram-webhook' } });
    return NextResponse.json(
      { ok: false, error: 'internal_error', message: (err as Error).message },
      { status: 500 },
    );
  }
}

export async function DELETE(req: Request): Promise<NextResponse> {
  if (!authorize(req)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  try {
    await getBot().api.deleteWebhook({ drop_pending_updates: true });
    const info = await getBot().api.getWebhookInfo();
    log.info({ event: 'admin.telegram.delete_webhook.ok' });
    return NextResponse.json({ ok: true, webhook: info });
  } catch (err) {
    log.error({ event: 'admin.telegram.delete_webhook.failed', err });
    Sentry.captureException(err, { tags: { source: 'admin.telegram-webhook' } });
    return NextResponse.json(
      { ok: false, error: 'internal_error', message: (err as Error).message },
      { status: 500 },
    );
  }
}
