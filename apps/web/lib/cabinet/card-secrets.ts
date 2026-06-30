import 'server-only';

import * as Sentry from '@sentry/nextjs';

import { getDb, findCardByIdForUser } from '@oplati/db';

import { getPaySpaceClient, isPaySpaceConfigured } from '../pay-space/index.ts';
import { childLogger } from '../logger.ts';

/**
 * Разовый показ полных реквизитов карты в кабинете (по запросу пользователя).
 *
 * Безопасность (критично): полные `pan`/`cvc`/срок НЕ хранятся в нашей БД (только
 * `pan_masked`). Здесь они тянутся ЖИВЫМ запросом из PaySpace (`getCardSecrets`)
 * и сразу уходят в ответ клиенту — НИКОГДА не логируются, не сохраняются, не
 * отправляются в Sentry. В логах — только событие + cardId (не реквизиты).
 *
 * Ownership: `findCardByIdForUser` отдаёт карту, только если она принадлежит
 * этому пользователю и не recycled (recycled-карта могла уйти другому клиенту).
 */

const log = childLogger('cabinet.card-secrets');

export type CardSecretsResult =
  | { ok: true; number: string; exp: string; cvc: string }
  | { ok: false; error: 'not_found' | 'unavailable' };

export async function getCardSecretsForUser(
  userId: string,
  cardId: string,
): Promise<CardSecretsResult> {
  const db = getDb();
  const card = await findCardByIdForUser(db, cardId, userId);
  if (!card) {
    return { ok: false, error: 'not_found' };
  }

  if (!isPaySpaceConfigured()) {
    log.warn({ event: 'cabinet.card_secrets.not_configured', cardId });
    return { ok: false, error: 'unavailable' };
  }

  try {
    const secrets = await getPaySpaceClient().getCardSecrets(card.providerCardId);
    // Номер группами по 4 для читабельности. Ничего из secrets НЕ логируем.
    const number = secrets.cardNo.replace(/(.{4})/g, '$1 ').trim();
    log.info({ event: 'cabinet.card_secrets.revealed', cardId });
    return { ok: true, number, exp: secrets.expDate, cvc: secrets.cvv };
  } catch {
    // НЕ передаём пойманную ошибку в лог/Sentry: при сбое парса контракта она
    // может нести сырое тело ответа с реквизитами. Только событие + cardId.
    log.error({ event: 'cabinet.card_secrets.failed', cardId });
    Sentry.captureMessage('card secrets fetch failed', {
      level: 'error',
      tags: { source: 'cabinet.card-secrets' },
      extra: { cardId },
    });
    return { ok: false, error: 'unavailable' };
  }
}
