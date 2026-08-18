import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';

import { claimStaffTotpStep, confirmStaffTotp, getDb, touchStaffLastLogin } from '@oplati/db';

import { serverEnv } from '@/lib/env.server';
import { childLogger } from '@/lib/logger';
import { completePanelLogin } from '@/lib/panel/login';
import {
  clearPanelCookies,
  panelLoginDeps,
  readPanelPendingCookie,
  setPanelSessionCookie,
} from '@/lib/panel/session';
import { verifyPanelToken } from '@/lib/panel/token';
import { checkRateLimit, getClientIp, isRateLimitDisabled } from '@/lib/ratelimit';

/**
 * POST /api/panel/auth/totp — второй фактор входа в панель.
 *
 * Принимает форму со страницы `/admin/login/code`. Форма обычная, без JS:
 * cookie `sameSite=lax` не уезжает на кросс-сайтовый POST, поэтому чужая
 * страница отправить код за сотрудника не может.
 *
 * Сотрудник перечитывается из базы: между факторами его могли отключить, а
 * промежуточный токен об этом не знает.
 *
 * ПОТОЛОК НА ПЕРЕБОР — два разных счётчика, и это принципиально:
 *   - по сотруднику (`admin-totp`) расходуется на КАЖДУЮ попытку. Только так
 *     закрывается перебор: при учёте одних промахов пачка параллельных запросов
 *     успевает проверить тысячу кодов до того, как счётчик их догонит, а
 *     угаданный код проходит мимо лимитера вовсе;
 *   - по IP (`admin-auth`) считает только промахи — как у `cabinet-auth`: за
 *     CGNAT и за собственным VPN один адрес на всех, и общий расход запирал бы
 *     живого сотрудника за чужой флуд.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const preferredRegion = 'fra1';
export const maxDuration = 15;

const log = childLogger('panel.auth');
const dbLog = childLogger('db');

const bodySchema = z.object({ code: z.string() });
const codeSchema = z.string().trim().regex(/^\d{6}$/);

function redirect(path: string): Response {
  return new Response(null, { status: 303, headers: { Location: path } });
}

export async function POST(req: Request): Promise<Response> {
  const ip = getClientIp(req);

  if (!serverEnv.ADMIN_SESSION_SECRET) {
    log.error({ event: 'panel.auth.not_configured', hasSessionSecret: false });
    return redirect('/admin/login?e=not_configured');
  }

  const pendingToken = await readPanelPendingCookie();
  const pending = verifyPanelToken(pendingToken ?? '', serverEnv.ADMIN_SESSION_SECRET, {
    purpose: 'pending',
  });
  if (!pending.ok) {
    // Промежуточный токен протух или его нет — начинать заново с первого
    // фактора. Лимит на это не расходуем: это не попытка подобрать код.
    log.info({ event: 'panel.auth.pending_missing', reason: pending.reason });
    return redirect('/admin/login?e=restart');
  }

  // Счётчик по СОТРУДНИКУ — до проверки кода и с расходом на каждую попытку.
  //
  // ⚠️ Гейта по IP здесь больше НЕТ намеренно: сотрудник на этом шаге уже
  // опознан подписанным `pending`-токеном, а блокировка по адресу запирала бы
  // живого человека за чужой флуд с того же CGNAT (или с нашего же VPN).
  // Перебор режет счётчик по сотруднику — он точнее и обойти его сменой IP
  // нельзя.
  const staffGate = await checkRateLimit('admin-totp', pending.staffId);
  if (!staffGate.allowed) {
    log.warn({ event: 'panel.auth.flood', stage: 'totp', by: 'staff', staffId: pending.staffId });
    return redirect('/admin/login/code?e=rate_limited');
  }

  // ⚠️ Fail-CLOSED, в отличие от клиентских путей. Счётчик попыток — ЕДИНСТВЕННЫЙ
  // барьер перебора второго фактора: `pending`-токен живёт 10 минут и
  // переиспользуется, кодов миллион, окон дрейфа три. Пропусти отказ Redis
  // молча — и владелец Telegram-аккаунта сотрудника подбирает шесть цифр за
  // часы. Осознанное отключение флагом (dev) от аварии отличаем явно.
  if (!staffGate.configured && !isRateLimitDisabled()) {
    log.error({ event: 'panel.auth.limiter_unavailable', stage: 'totp', staffId: pending.staffId });
    return redirect('/admin/login/code?e=rate_limited');
  }

  const code = await readCode(req);
  if (!code) {
    await checkRateLimit('admin-auth', ip);
    return redirect('/admin/login/code?e=bad_code');
  }

  let res: Awaited<ReturnType<typeof completePanelLogin>>;
  try {
    res = await completePanelLogin({
      staffId: pending.staffId,
      code,
      findStaffById: panelLoginDeps.findStaffById,
      confirmTotp: (input) => confirmStaffTotp(getDb(), input, dbLog),
      claimTotpStep: (input) => claimStaffTotpStep(getDb(), input, dbLog),
      touchLastLogin: (staffId) => touchStaffLastLogin(getDb(), staffId),
    });
  } catch (err) {
    log.error({ event: 'panel.auth.failed', stage: 'totp', err });
    Sentry.captureException(err, { tags: { source: 'panel.auth' } });
    return redirect('/admin/login?e=unavailable');
  }

  if (!res.ok) {
    await checkRateLimit('admin-auth', ip);
    log.warn({ event: 'panel.auth.rejected', stage: 'totp', reason: res.reason });
    if (res.reason === 'bad_code') return redirect('/admin/login/code?e=bad_code');
    // Код уже использовали — почти всегда это повторная отправка формы самим
    // сотрудником, и он должен понять, что надо дождаться следующего кода.
    if (res.reason === 'code_used') return redirect('/admin/login/code?e=code_used');
    // Сотрудника отключили или потерялся секрет привязки — обратно на первый
    // фактор, промежуточный токен больше не нужен.
    await clearPanelCookies();
    return redirect(`/admin/login?e=${res.reason}`);
  }

  await setPanelSessionCookie(res.actor.id);
  log.info({ event: 'panel.auth.signed_in', staffId: res.actor.id, role: res.actor.role });

  return redirect('/admin');
}

/**
 * Код из формы или из JSON. Форма — основной путь (страница входа), JSON
 * оставлен для ручных проверок curl'ом; на контракт это не влияет.
 */
async function readCode(req: Request): Promise<string | null> {
  const contentType = req.headers.get('content-type') ?? '';
  try {
    if (contentType.includes('application/json')) {
      const body = bodySchema.safeParse(await req.json());
      if (!body.success) return null;
      const parsed = codeSchema.safeParse(body.data.code);
      return parsed.success ? parsed.data : null;
    }
    const form = await req.formData();
    const parsed = codeSchema.safeParse(String(form.get('code') ?? ''));
    return parsed.success ? parsed.data : null;
  } catch (err) {
    // Битое тело — это отказ входа, а не 500 на странице.
    log.warn({ event: 'panel.auth.bad_body', err });
    return null;
  }
}
