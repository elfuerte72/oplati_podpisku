import 'server-only';

import { after } from 'next/server';
import { z } from 'zod';

import { getDb, setTelegramUsername } from '@oplati/db';

import { serverEnv } from '@/lib/env.server';
import { fetchJsonWithTimeout } from '@/lib/http';
import { childLogger } from '@/lib/logger';

import { normalizeUsername } from './telegram-dm';

/**
 * Сверка @username клиента с Telegram — чтобы ссылка на личку в карточке была
 * не только у тех, кто написал боту после появления колонки.
 *
 * Почему вообще нужен поход в Bot API: username пишется из апдейтов бота и
 * initData кабинета, но у базы, накопленной ДО этого, поля нет вовсе. Один
 * `getChat` по `telegram_id` возвращает его для всех, с кем у бота есть чат, —
 * то есть для всех наших клиентов (иначе они бы не оформили заказ). Контракт
 * снят живым вызовом 2026-09-09: `{"ok":true,"result":{"id":…,"first_name":…}}`,
 * поле `username` присутствует, только если оно есть у человека.
 *
 * ⚠️ Отметка о сверке пишется и при ПУСТОМ ответе: username может не быть вовсе
 * (на выборке из 25 клиентов прода — у 3), и без памятки карточка ходила бы в
 * Telegram на каждое открытие. Отметка живёт неделю — за это время username
 * успевает и появиться, и смениться, а десяток лишних запросов в неделю не
 * стоит того, чтобы держать протухшую ссылку дольше.
 *
 * Всё best-effort: сбой Bot API не должен ронять карточку клиента, поэтому
 * возвращаем то, что знали, и пишем предупреждение в лог.
 */

const log = childLogger('panel-client-username');

/** Насколько долго верим прошлой сверке. */
export const USERNAME_RECHECK_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Поводок на запрос к Telegram. Карточка ждёт его СИНХРОННО (значение нужно
 * для ссылки), поэтому две секунды: медленный Bot API не должен превращать
 * открытие клиента в ожидание.
 */
const GET_CHAT_TIMEOUT_MS = 2_000;

/** Ответ `getChat` — берём ровно одно поле, остальное нас не касается. */
const getChatSchema = z.object({
  ok: z.literal(true),
  result: z.object({ username: z.string().optional() }),
});

export type ClientUsernameInput = {
  userId: string;
  telegramId: string | null;
  telegramUsername: string | null;
  telegramUsernameCheckedAt: Date | null;
};

/**
 * Возвращает актуальный username клиента (без `@`) или `null`, если его нет.
 * Побочный эффект — запись результата сверки — уходит в `after()`.
 */
export async function ensureClientTelegramUsername(
  client: ClientUsernameInput,
  now: Date = new Date(),
): Promise<string | null> {
  const known = normalizeUsername(client.telegramUsername);
  if (!client.telegramId || client.telegramId.trim().length === 0) return known;
  if (!needsRecheck(client.telegramUsernameCheckedAt, now)) return known;

  const token = serverEnv.TELEGRAM_BOT_TOKEN;
  if (!token) return known;

  let fresh: string | null;
  try {
    const res = await fetchJsonWithTimeout(
      `https://api.telegram.org/bot${token}/getChat?chat_id=${encodeURIComponent(client.telegramId)}`,
      { method: 'GET' },
      getChatSchema,
      GET_CHAT_TIMEOUT_MS,
    );
    // `null` — недоступный Telegram, «chat not found» или неожиданное тело.
    // Ни одно из этого не факт «username нет»: записать пустоту значило бы
    // погасить рабочую ссылку на неделю по чужой ошибке.
    if (!res) {
      log.warn({ event: 'panel.client_username.lookup_empty' });
      return known;
    }
    fresh = normalizeUsername(res.result.username);
  } catch (err) {
    // Ожидаемые неудачи: таймаут, обрыв соединения. Не повод ронять экран и не
    // повод для Sentry — карточка покажет то, что знала, сверка повторится.
    log.warn({ event: 'panel.client_username.lookup_failed', err });
    return known;
  }

  persistLater(client.userId, fresh);
  return fresh;
}

function needsRecheck(checkedAt: Date | null, now: Date): boolean {
  if (!checkedAt) return true;
  return now.getTime() - checkedAt.getTime() > USERNAME_RECHECK_AFTER_MS;
}

/**
 * Запись результата — после ответа страницы: рендер карточки не должен ждать
 * ещё и UPDATE. Вне запроса (тест, скрипт) `after()` бросает — тогда пишем
 * синхронно, тем же приёмом, что и аналитика (`lib/analytics/track.ts`).
 */
function persistLater(userId: string, username: string | null): void {
  const write = async () => {
    try {
      await setTelegramUsername(getDb(), { userId, username });
    } catch (err) {
      log.warn({ event: 'panel.client_username.persist_failed', err });
    }
  };
  try {
    after(write);
  } catch {
    void write();
  }
}
