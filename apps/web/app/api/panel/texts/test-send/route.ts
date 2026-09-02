import * as Sentry from '@sentry/nextjs';
import { GrammyError } from 'grammy';
import { z } from 'zod';

import { getDb } from '@oplati/db';

import { formatReferralTelegramLink } from '@/lib/cabinet/referral-read';
import { renderFunnelText } from '@/lib/funnel/texts';
import { childLogger } from '@/lib/logger';
import { checkFunnelTextForKey, funnelTextErrorResponse } from '@/lib/panel/funnel-texts';
import { assertPanelRequestOrigin, guardPanelOperation, panelGuardResponse } from '@/lib/panel/guard';
import { FUNNEL_TEXTS_TEXT } from '@/lib/panel/labels';
import { checkRateLimit } from '@/lib/ratelimit';
import { getBot, getBotUsername } from '@/lib/telegram/bot';
import { referralMiniAppShortName } from '@/lib/telegram/deep-links';

/**
 * POST /api/panel/texts/test-send — отправить текст воронки себе в Telegram
 * ДО сохранения (панель v2, ветка C, тикет 12): владелец видит формулировку
 * глазами клиента.
 *
 * Та же валидация, что при сохранении — невалидный текст не уходит (`422`).
 * Рендер — с образцовыми подстановками: `{service}` = «Netflix», `{link}` —
 * deep-link клиентского бота с `ref_TEST` ТЕМ ЖЕ билдером, что в кабинете,
 * чтобы формат совпадал. Уходит КЛИЕНТСКИМ ботом на `staff.telegram_id`
 * актора БЕЗ клавиатуры: кнопки `fb:*` от сотрудника писали бы
 * `client_feedback` и `funnel_opt_out_at` ему как клиенту. В `funnel_sends`,
 * `client_feedback`, `messages` ничего не пишется — это не воронка и не
 * переписка.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const preferredRegion = 'fra1';
export const maxDuration = 15;

const log = childLogger('panel.texts');

const bodySchema = z.object({
  key: z.string().min(1).max(100),
  value: z.string().max(8192),
});

// Образцовые подстановки для предпросмотра (роут экспортирует только
// обработчики — прочие экспорты Next отвергает при сборке).
const SAMPLE_SERVICE = 'Netflix';
const SAMPLE_REF_CODE = 'TEST';

export async function POST(req: Request): Promise<Response> {
  if (!(await assertPanelRequestOrigin(req))) {
    return Response.json({ ok: false, error: 'forbidden' }, { status: 403 });
  }

  const guard = await guardPanelOperation('texts');
  if (!guard.ok) return panelGuardResponse(guard);

  let body: z.infer<typeof bodySchema>;
  try {
    const parsed = bodySchema.safeParse(await req.json());
    if (!parsed.success) {
      return Response.json({ ok: false, error: 'invalid_body' }, { status: 400 });
    }
    body = parsed.data;
  } catch {
    return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }

  const telegramId = guard.actor.telegramId;
  if (!telegramId) return Response.json({ ok: false, error: 'no_telegram' }, { status: 409 });

  // Кап — по сотруднику, ДО валидации и похода в Telegram: каждая отправка —
  // исходящий вызов Bot API.
  const limit = await checkRateLimit('panel-texts-test', guard.actor.id);
  if (!limit.allowed) {
    return Response.json({ ok: false, error: 'rate_limited' }, { status: 429 });
  }

  let check: Awaited<ReturnType<typeof checkFunnelTextForKey>>;
  try {
    check = await checkFunnelTextForKey(getDb(), body.key, body.value);
  } catch (err) {
    // Проверка читает соседей из БД: отказ базы — 503, а не 500.
    log.error({ event: 'panel.texts.check_failed', staffId: guard.actor.id, err });
    Sentry.captureException(err, { tags: { source: 'panel.texts' } });
    return Response.json({ ok: false, error: 'unavailable' }, { status: 503 });
  }
  if (!check.ok) return funnelTextErrorResponse(check);

  // Ссылка — тем же билдером, что в кабинете; без username бота ссылки нет,
  // и подстановка честно показывает это словами, а не пустотой. Username
  // нужен и тексту отказа «запустите бота @…».
  let botUsername: string | null = null;
  let link = `ref_${SAMPLE_REF_CODE}`;
  try {
    botUsername = await getBotUsername();
    link = formatReferralTelegramLink(SAMPLE_REF_CODE, botUsername, referralMiniAppShortName()) ?? link;
  } catch (err) {
    log.warn({ event: 'panel.texts.test_link_failed', staffId: guard.actor.id, err });
  }

  const rendered = renderFunnelText(check.value, { service: SAMPLE_SERVICE, link });
  // Кнопку без сообщения показать нельзя — подпись (и кнопки, и ответа
  // опроса) уходит текстом с пометкой.
  const isButton = check.spec.kind === 'button' || check.spec.kind === 'answer';
  const text = isButton ? `${FUNNEL_TEXTS_TEXT.buttonPreviewPrefix} ${rendered}` : rendered;

  let bot: ReturnType<typeof getBot>;
  try {
    bot = getBot();
  } catch (err) {
    log.error({ event: 'panel.texts.bot_unavailable', staffId: guard.actor.id, err });
    Sentry.captureException(err, { tags: { source: 'panel.texts' } });
    return Response.json({ ok: false, error: 'unavailable' }, { status: 503 });
  }

  try {
    // Без reply_markup намеренно (см. шапку).
    await bot.api.sendMessage(telegramId, text);
  } catch (err) {
    if (err instanceof GrammyError && err.error_code === 403) {
      log.warn({ event: 'panel.texts.test_bot_blocked', staffId: guard.actor.id });
      // Имя бота — в теле: словарь панели env не читает, компонент дописывает «@…».
      return Response.json({ ok: false, error: 'bot_blocked', bot: botUsername }, { status: 409 });
    }
    log.error({ event: 'panel.texts.test_send_failed', staffId: guard.actor.id, err });
    Sentry.captureException(err, { tags: { source: 'panel.texts' } });
    return Response.json({ ok: false, error: 'send_failed' }, { status: 502 });
  }

  log.info({ event: 'panel.texts.test_sent', staffId: guard.actor.id, key: check.spec.key });
  return Response.json({ ok: true });
}
