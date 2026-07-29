import 'server-only';

import * as Sentry from '@sentry/nextjs';
import { InlineKeyboard } from 'grammy';
import type { InputMediaPhoto } from 'grammy/types';

import { findVpnSubscriptionByUserId, getDb, upsertVpnSubscription } from '@oplati/db';
import type { RemnawaveUser, TelegramCallbackQuery } from '@oplati/types';

import { siteUrl } from '@/lib/deployment-url';
import { serverEnv } from '@/lib/env.server';
import { childLogger } from '@/lib/logger';
import {
  getRemnawaveClient,
  isRemnawaveConfigured,
  isUnlimitedSubscriptionMode,
  RemnawaveApiError,
  targetSubscriptionExpiry,
} from '@/lib/remnawave';

import { getBot } from './bot';
import { resolveCallbackContext, safeAppendMessage, type PersistContext } from './persist';
import { sendSafely } from './send';
import {
  buildVpnMessageHtml,
  HAPP_APPSTORE_URL,
  HAPP_GOOGLEPLAY_URL,
  VPN_APPSTORE_BUTTON,
  VPN_ERROR_TEXT,
  VPN_GOOGLEPLAY_BUTTON,
  VPN_REFRESH_BUTTON,
  VPN_UNAVAILABLE_TEXT,
} from './templates';

/**
 * VPN Оплатишки — выдача ссылки-подписки Remnawave по кнопке «VPN» в /start-меню.
 *
 * Флоу (callback `vpn`):
 *   1. Строка в `vpn_subscriptions` есть → возвращаем ту же ссылку (новая НЕ
 *      генерируется — подписка per-user и стабильна по shortUuid).
 *   2. Строки нет → ищем юзера панели `by-telegram-id` (идемпотентность: не
 *      плодим дубли), нет и там → создаём (username `tg_<id>`, срок из
 *      `REMNAWAVE_SUBSCRIPTION_MONTHS`, Default-Squad) → upsert снимка в БД →
 *      ссылка + инструкция клиенту.
 *
 * Срок по умолчанию — БЕЗ ОГРАНИЧЕНИЯ (решение владельца 2026-07-29: VPN
 * бесплатный, месячный срок давал клиенту только мёртвую ссылку). Уже выданные
 * месячные подписки подтягиваются к бессрочным при первом же нажатии кнопки —
 * см. `liftLegacyExpiry`.
 *
 * Кнопка «Обновить ссылку» (callback `vpn:refresh`) — перевыпуск: в панели
 * `actions/revoke` МЕНЯЕТ shortUuid (старая ссылка перестаёт работать сразу),
 * срок действия сам по себе НЕ продлевается — в срочном режиме кнопка иначе
 * была бы бесплатным продлением.
 * Юзер панели тот же, обновляется только снимок в БД. Если юзера панели
 * удалили вручную (404) — выпускаем заново.
 *
 * Все вызовы панели server-side; graceful degradation: не настроен токен /
 * лежит БД / лежит панель → понятный текст, не молчание.
 */

const log = childLogger('telegram-bot');
const dbLog = childLogger('db');

/** Скриншоты шагов подключения Happ (apps/web/public/vpn/, отдаются с деплоя). */
const VPN_STEP_IMAGES = ['happ-step-1.jpg', 'happ-step-2.jpg', 'happ-step-3.jpg'] as const;

function vpnKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .url(VPN_APPSTORE_BUTTON, HAPP_APPSTORE_URL)
    .row()
    .url(VPN_GOOGLEPLAY_BUTTON, HAPP_GOOGLEPLAY_URL)
    .row()
    .text(VPN_REFRESH_BUTTON, 'vpn:refresh');
}

/**
 * Альбом со скриншотами «как добавить подписку в Happ». Вспомогательный:
 * сбой отправки (например, Telegram не смог скачать фото) не блокирует
 * выдачу ссылки — логируем и едем дальше.
 */
async function sendVpnStepsAlbum(chatId: number, updateId: number): Promise<void> {
  const base = siteUrl();
  const media: InputMediaPhoto[] = VPN_STEP_IMAGES.map((name, i) => ({
    type: 'photo',
    media: `${base}/vpn/${name}`,
    ...(i === 0
      ? { caption: 'Подключаем за 3 шага: жми «+», выбери «URL подписки», вставь ссылку.' }
      : {}),
  }));
  try {
    await getBot().api.sendMediaGroup(chatId, media);
  } catch (err) {
    log.warn({ event: 'telegram.vpn.album_failed', updateId, chatId, err });
  }
}

/** Снимок юзера панели → upsert в `vpn_subscriptions` (по user_id). */
async function persistSnapshot(
  ctx: PersistContext,
  telegramId: string,
  panelUser: RemnawaveUser,
): Promise<void> {
  await upsertVpnSubscription(
    getDb(),
    {
      userId: ctx.userId,
      telegramId,
      remnawaveUuid: panelUser.uuid,
      shortUuid: panelUser.shortUuid,
      subscriptionUrl: panelUser.subscriptionUrl,
      status: panelUser.status,
      expireAt: panelUser.expireAt,
    },
    dbLog,
  );
}

/**
 * Ссылка + инструкция клиенту (HTML) с кнопками сторов и «Обновить ссылку».
 * Перед сообщением всегда идёт альбом со скриншотами шагов (решение владельца
 * 2026-07-21: фотки и при повторном нажатии — инструкция всегда под рукой).
 */
async function replyWithSubscription(
  ctx: PersistContext,
  chatId: number,
  updateId: number,
  kind: 'new' | 'existing' | 'refreshed',
  subscriptionUrl: string,
  expireAt: Date,
): Promise<void> {
  await sendVpnStepsAlbum(chatId, updateId);
  const html = buildVpnMessageHtml({
    kind,
    subscriptionUrl,
    expireAt,
    trafficLimitGb: serverEnv.REMNAWAVE_TRAFFIC_LIMIT_GB,
  });
  // В историю messages — БЕЗ ссылки (находка ревью): ссылка-подписка — это
  // credential, она уже хранится в vpn_subscriptions, дубль в переписке
  // (с 90-дневной ретенцией и без нужды) только расширяет поверхность утечки.
  const redactedHtml = buildVpnMessageHtml({
    kind,
    subscriptionUrl: '[ссылка скрыта]',
    expireAt,
    trafficLimitGb: serverEnv.REMNAWAVE_TRAFFIC_LIMIT_GB,
  });
  await safeAppendMessage(ctx, 'assistant', redactedHtml, { source: 'vpn' }, updateId);
  await sendSafely(chatId, html, updateId, vpnKeyboard(), { parseMode: 'HTML' });
}

/**
 * Подтягивает юзера панели к текущим настройкам: лимит трафика (легаси-юзеры,
 * созданные до введения лимита 200 ГБ, оставались безлимитными) и срок доступа.
 *
 * Срок двигаем ТОЛЬКО вверх и ТОЛЬКО в безлимитном режиме. В срочном режиме
 * такой синк был бы бесплатным продлением на каждое нажатие кнопки — ровно то,
 * ради чего «Обновить ссылку» намеренно не трогает `expireAt`.
 *
 * Best-effort: сбой синка не блокирует выдачу ссылки. Возвращает обновлённого
 * юзера панели (или исходного, если синк не понадобился либо не удался) —
 * дальше он идёт и в снимок БД, и в текст клиенту, поэтому важно не потерять
 * новые значения.
 */
async function syncPanelLimits(
  panelUser: RemnawaveUser,
  updateId: number,
): Promise<RemnawaveUser> {
  const targetBytes = serverEnv.REMNAWAVE_TRAFFIC_LIMIT_GB * 1024 ** 3;
  const patch: { trafficLimitBytes?: number; expireAt?: Date } = {};

  if (panelUser.trafficLimitBytes !== undefined && panelUser.trafficLimitBytes !== targetBytes) {
    patch.trafficLimitBytes = targetBytes;
  }
  const targetExpiry = targetSubscriptionExpiry();
  if (isUnlimitedSubscriptionMode() && panelUser.expireAt < targetExpiry) {
    patch.expireAt = targetExpiry;
  }
  if (patch.trafficLimitBytes === undefined && patch.expireAt === undefined) return panelUser;

  try {
    const updated = await getRemnawaveClient().updateUser({ uuid: panelUser.uuid, ...patch });
    log.info({
      event: 'telegram.vpn.limits_synced',
      updateId,
      traffic: patch.trafficLimitBytes !== undefined,
      expiry: patch.expireAt !== undefined,
    });
    return updated;
  } catch (err) {
    log.warn({ event: 'telegram.vpn.limits_sync_failed', updateId, err });
    // Выдачу ссылки не блокируем, но и молчать нельзя: постоянный отказ синка
    // означает, что лимиты и сроки в панели разъехались с настройками.
    Sentry.captureException(err, { tags: { source: 'telegram.vpn', step: 'sync_limits' } });
    return panelUser;
  }
}

/**
 * Подтягивает срок УЖЕ выданной подписки к бессрочному, когда включён
 * безлимитный режим.
 *
 * Повторное нажатие «VPN» отвечает из снимка в БД и панель не трогает вовсе —
 * поэтому клиенты, получившие подписку в эпоху месячного срока, иначе так и
 * получали бы мёртвую ссылку с прошедшей датой (панель сама переводит юзера в
 * EXPIRED по `expireAt`). Патчим по `remnawaveUuid` из снимка, без лишнего GET.
 *
 * Срабатывает один раз на клиента: после успешного PATCH снимок несёт уже
 * бессрочную дату, и следующее нажатие в панель не пойдёт. Сбой (в том числе
 * 404 удалённого вручную юзера) не ломает выдачу — вернём прежний срок, а
 * протухший клиент увидит честную пометку вместо молчания.
 */
async function liftLegacyExpiry(
  ctx: PersistContext,
  telegramId: string,
  existing: { remnawaveUuid: string; expireAt: Date },
  updateId: number,
): Promise<Date> {
  const target = targetSubscriptionExpiry();
  if (!isUnlimitedSubscriptionMode() || existing.expireAt >= target) return existing.expireAt;
  try {
    const updated = await getRemnawaveClient().updateUser({
      uuid: existing.remnawaveUuid,
      expireAt: target,
    });
    await persistSnapshot(ctx, telegramId, updated);
    log.info({ event: 'telegram.vpn.expiry_lifted', updateId });
    return updated.expireAt;
  } catch (err) {
    log.warn({ event: 'telegram.vpn.expiry_lift_failed', updateId, err });
    // Клиент получит ссылку с прежним (возможно истёкшим) сроком и честную
    // пометку — но знать, что панель не даёт продлить, нужно нам.
    Sentry.captureException(err, { tags: { source: 'telegram.vpn', step: 'lift_expiry' } });
    return existing.expireAt;
  }
}

/**
 * Callback `vpn`: выдать ссылку-подписку (или вернуть существующую).
 */
export async function handleVpnCallback(
  cb: TelegramCallbackQuery,
  chatId: number,
  updateId: number,
): Promise<void> {
  if (!isRemnawaveConfigured()) {
    log.warn({ event: 'telegram.vpn.not_configured', updateId, chatId });
    await sendSafely(chatId, VPN_UNAVAILABLE_TEXT, updateId);
    return;
  }
  const ctx = await resolveCallbackContext(cb, updateId);
  if (!ctx) {
    await sendSafely(chatId, VPN_UNAVAILABLE_TEXT, updateId);
    return;
  }
  const telegramId = String(cb.from.id);

  try {
    const existing = await findVpnSubscriptionByUserId(getDb(), ctx.userId);
    if (existing) {
      log.info({ event: 'telegram.vpn.existing', updateId, chatId });
      const expireAt = await liftLegacyExpiry(ctx, telegramId, existing, updateId);
      await replyWithSubscription(
        ctx,
        chatId,
        updateId,
        'existing',
        existing.subscriptionUrl,
        expireAt,
      );
      return;
    }

    const client = getRemnawaveClient();
    // Идемпотентность к панели: юзер мог быть создан раньше (или снимок в БД
    // потерялся) — один telegramId = один юзер панели, дубли не плодим.
    let panelUser = await client.findUserByTelegramId(telegramId);
    let created = false;
    if (!panelUser) {
      try {
        panelUser = await client.createUser({
          telegramId,
          expireAt: targetSubscriptionExpiry(),
        });
        created = true;
      } catch (err) {
        // Дребезг кнопки: параллельный callback создал юзера первым (username
        // в панели уникален, второй create падает) — перечитываем и едем дальше.
        const raced = await client.findUserByTelegramId(telegramId);
        if (!raced) throw err;
        log.info({ event: 'telegram.vpn.create_raced', updateId, chatId });
        panelUser = raced;
      }
    }
    if (!created) {
      panelUser = await syncPanelLimits(panelUser, updateId);
    }
    await persistSnapshot(ctx, telegramId, panelUser);
    log.info({ event: created ? 'telegram.vpn.issued' : 'telegram.vpn.adopted', updateId, chatId });
    await replyWithSubscription(
      ctx,
      chatId,
      updateId,
      created ? 'new' : 'existing',
      panelUser.subscriptionUrl,
      panelUser.expireAt,
    );
  } catch (err) {
    log.error({ event: 'telegram.vpn.failed', updateId, chatId, err });
    Sentry.captureException(err, { tags: { source: 'telegram.vpn' } });
    await sendSafely(chatId, VPN_ERROR_TEXT, updateId);
  }
}

/**
 * Callback `vpn:refresh`: перевыпустить ссылку. Старая отзывается в панели
 * (revoke) и в снимке БД заменяется новой; срок действия сохраняется.
 */
export async function handleVpnRefreshCallback(
  cb: TelegramCallbackQuery,
  chatId: number,
  updateId: number,
): Promise<void> {
  if (!isRemnawaveConfigured()) {
    log.warn({ event: 'telegram.vpn.not_configured', updateId, chatId });
    await sendSafely(chatId, VPN_UNAVAILABLE_TEXT, updateId);
    return;
  }
  const ctx = await resolveCallbackContext(cb, updateId);
  if (!ctx) {
    await sendSafely(chatId, VPN_UNAVAILABLE_TEXT, updateId);
    return;
  }
  const telegramId = String(cb.from.id);

  try {
    const existing = await findVpnSubscriptionByUserId(getDb(), ctx.userId);
    if (!existing) {
      // «Обновить» без снимка в БД (старое сообщение после потери данных) —
      // ведём себя как обычная выдача.
      await handleVpnCallback(cb, chatId, updateId);
      return;
    }

    const client = getRemnawaveClient();
    let panelUser: RemnawaveUser;
    try {
      panelUser = await client.revokeSubscription(existing.remnawaveUuid);
    } catch (err) {
      if (err instanceof RemnawaveApiError && err.status === 404) {
        // Юзера панели удалили вручную — снимок протух, выпускаем заново.
        // Живой срок сохраняем (перевыпуск ссылки не продлевает доступ),
        // истёкший — берём целевой, иначе создали бы уже EXPIRED юзера.
        log.warn({ event: 'telegram.vpn.refresh_recreate', updateId, chatId });
        const target = targetSubscriptionExpiry();
        panelUser = await client.createUser({
          telegramId,
          expireAt: existing.expireAt > new Date() ? existing.expireAt : target,
        });
      } else {
        throw err;
      }
    }
    panelUser = await syncPanelLimits(panelUser, updateId);
    await persistSnapshot(ctx, telegramId, panelUser);
    log.info({ event: 'telegram.vpn.refreshed', updateId, chatId });
    await replyWithSubscription(
      ctx,
      chatId,
      updateId,
      'refreshed',
      panelUser.subscriptionUrl,
      panelUser.expireAt,
    );
  } catch (err) {
    log.error({ event: 'telegram.vpn.refresh_failed', updateId, chatId, err });
    Sentry.captureException(err, { tags: { source: 'telegram.vpn' } });
    await sendSafely(chatId, VPN_ERROR_TEXT, updateId);
  }
}
