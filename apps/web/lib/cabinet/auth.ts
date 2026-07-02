import 'server-only';

import * as Sentry from '@sentry/nextjs';

import { getDb, getOrCreateUserByTelegramId } from '@oplati/db';
import type { TelegramWebAppUser } from '@oplati/types';

import { serverEnv } from '../env.server.ts';
import { childLogger } from '../logger.ts';
import {
  validateInitData,
  telegramUserDisplayName,
  type InitDataFailureReason,
} from '../telegram/init-data.ts';
import { captureReferralFromStartParam } from './referral-capture.ts';

/**
 * Резолв пользователя кабинета по `initData` Mini App: проверяем подпись,
 * затем upsert'им `users`-строку по `telegram_id`. Это единственная точка
 * авторизации кабинета — все запросы `/api/cabinet` проходят через неё.
 *
 * Результат — дискриминированный: `ok:false` несёт HTTP-статус для роута
 * (`401` неверная/протухшая подпись, `500` бот-токен не настроен, `503` БД
 * недоступна).
 */

const log = childLogger('cabinet.auth');
const dbLog = childLogger('db');

export type CabinetUser = {
  userId: string;
  telegramId: string;
  user: TelegramWebAppUser;
};

export type ResolveCabinetUserResult =
  | { ok: true; user: CabinetUser }
  | { ok: false; status: number; error: InitDataFailureReason | 'misconfigured' | 'db_unavailable' };

export async function resolveCabinetUser(initData: string): Promise<ResolveCabinetUserResult> {
  const botToken = serverEnv.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    log.error({ event: 'cabinet.auth.misconfigured', missing: 'TELEGRAM_BOT_TOKEN' });
    return { ok: false, status: 500, error: 'misconfigured' };
  }

  const validated = validateInitData(initData, botToken);
  if (!validated.ok) {
    log.warn({ event: 'cabinet.auth.rejected', reason: validated.reason });
    return { ok: false, status: 401, error: validated.reason };
  }

  const telegramId = String(validated.user.id);
  try {
    const { id } = await getOrCreateUserByTelegramId(
      getDb(),
      {
        telegramId,
        displayName: telegramUserDisplayName(validated.user),
        language: validated.user.language_code ?? 'ru',
      },
      dbLog,
    );
    // Реферальный захват из `startapp=ref_<code>` — best-effort, не влияет на auth
    // (helper сам глотает ошибки и гейтит по REFERRAL_ENABLED / покупкам).
    await captureReferralFromStartParam({ userId: id, startParam: validated.startParam });
    return { ok: true, user: { userId: id, telegramId, user: validated.user } };
  } catch (err) {
    log.error({ event: 'cabinet.auth.db_failed', err });
    Sentry.captureException(err, { tags: { source: 'cabinet.auth' } });
    return { ok: false, status: 503, error: 'db_unavailable' };
  }
}
