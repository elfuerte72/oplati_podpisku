import * as Sentry from '@sentry/nextjs';

import { claimOnce } from '@/lib/dedup';
import { serverEnv } from '@/lib/env.server';
import { childLogger } from '@/lib/logger';
import { beginPanelLogin } from '@/lib/panel/login';
import { panelLoginDeps, setPanelPendingCookie } from '@/lib/panel/session';
import { LOGIN_WIDGET_MAX_AGE_SECONDS } from '@/lib/panel/telegram-login';
import { checkRateLimit, getClientIp, peekRateLimit } from '@/lib/ratelimit';

/**
 * GET /api/panel/auth/telegram — первый фактор входа в панель.
 *
 * Сюда Telegram Login Widget присылает браузер сотрудника (`data-auth-url`) с
 * подписанным payload'ом в query. Метод GET здесь не небрежность: виджет умеет
 * ровно такой переход, а подделать payload нельзя — он подписан HMAC по токену
 * бота входа и живёт минуты.
 *
 * Доступа этот роут НЕ выдаёт: в cookie кладётся промежуточный токен, который
 * сессией не является по построению (`purpose` внутри подписи). Дальше —
 * страница ввода кода.
 *
 * Отказ всегда один и тот же для «нет такого сотрудника» и «сотрудник
 * отключён»: различимые ответы рассказывали бы постороннему, кто у нас
 * работает, а кнопка входа публичная.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const preferredRegion = 'fra1';
export const maxDuration = 15;

const log = childLogger('panel.auth');

/** Куда возвращаем браузер. Относительный Location — панель живёт за Traefik. */
function redirect(path: string): Response {
  return new Response(null, { status: 303, headers: { Location: path } });
}

export async function GET(req: Request): Promise<Response> {
  const ip = getClientIp(req);

  // Конфиг проверяем ПЕРВЫМ. Иначе при заданном токене бота и незаданном
  // `ADMIN_SESSION_SECRET` (промежуточное состояние выката) первый фактор
  // проходил бы, ПЕРЕВЫДАВАЛ секрет привязки в базе — и только потом падал 500
  // на подписи cookie.
  if (!serverEnv.TELEGRAM_LOGIN_BOT_TOKEN || !serverEnv.ADMIN_SESSION_SECRET) {
    log.error({
      event: 'panel.auth.not_configured',
      hasBotToken: Boolean(serverEnv.TELEGRAM_LOGIN_BOT_TOKEN),
      hasSessionSecret: Boolean(serverEnv.ADMIN_SESSION_SECRET),
    });
    return redirect('/admin/login?e=not_configured');
  }

  // Лимитер спрашиваем ДО проверки payload'а и БЕЗ расхода: считаются только
  // неудачные попытки, поэтому одного `checkRateLimit` на ветке отказа мало —
  // успешная попытка проходила бы мимо лимитера вовсе.
  const gate = await peekRateLimit('admin-auth', ip);
  if (!gate.allowed) {
    log.warn({ event: 'panel.auth.flood', stage: 'telegram' });
    return redirect('/admin/login?e=rate_limited');
  }

  const payload = Object.fromEntries(new URL(req.url).searchParams.entries());

  let res: Awaited<ReturnType<typeof beginPanelLogin>>;
  try {
    res = await beginPanelLogin({
      payload,
      botToken: serverEnv.TELEGRAM_LOGIN_BOT_TOKEN,
      findStaffByTelegramId: panelLoginDeps.findStaffByTelegramId,
      startTotpEnrollment: panelLoginDeps.startTotpEnrollment,
      claimPayloadOnce: (signature) =>
        // Fail-open внутри `claimOnce` (нет Redis — «право взято»): без
        // хранилища переигровка снова возможна, но она и так упирается в
        // пятиминутный срок и во второй фактор.
        claimOnce(`panel:login:${signature}`, LOGIN_WIDGET_MAX_AGE_SECONDS),
    });
  } catch (err) {
    // Недоступная база не должна давать 500 на странице входа: сотрудник
    // увидит понятный отказ, а мы — алёрт.
    log.error({ event: 'panel.auth.failed', stage: 'telegram', err });
    Sentry.captureException(err, { tags: { source: 'panel.auth' } });
    return redirect('/admin/login?e=unavailable');
  }

  if (!res.ok) {
    // Расходуем лимит: это неудачная попытка входа.
    await checkRateLimit('admin-auth', ip);
    log.warn({ event: 'panel.auth.rejected', stage: 'telegram', reason: res.reason });
    return redirect(`/admin/login?e=${res.reason}`);
  }

  await setPanelPendingCookie(res.actor.id);
  log.info({ event: 'panel.auth.first_factor', staffId: res.actor.id, stage: res.stage });

  return redirect('/admin/login/code');
}
