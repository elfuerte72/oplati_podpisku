import 'server-only';

import { Api, GrammyError } from 'grammy';
import { after } from 'next/server';

import { getDb, setTelegramUsername, touchTelegramUsernameCheck } from '@oplati/db';

import { serverEnv } from '@/lib/env.server';
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
 * снят живым вызовом 2026-09-09: поле `username` присутствует, только если оно
 * есть у человека.
 *
 * ⚠️ Отметка о сверке пишется ВСЕГДА, когда Telegram ответил, — в том числе на
 * пустоту (username нет вовсе) и на отказ «чат недоступен». Без неё карточка
 * такого клиента ходила бы в Bot API на каждое открытие, а страница панели
 * живая: `router.refresh()` раз в 25 секунд превратил бы это в поток запросов.
 *
 * ⚠️ Окно — СУТКИ, а не неделя: освободившийся @username Telegram отдаёт
 * другому человеку, и протухшая ссылка означает не «кнопка не работает», а
 * «оператор написал постороннему».
 *
 * Всё best-effort: сбой Bot API не должен ронять карточку клиента.
 */

const log = childLogger('panel-client-username');

/** Насколько долго верим прошлой сверке. */
export const USERNAME_RECHECK_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Поводок на запрос к Telegram. Ждём его синхронно только когда username
 * НЕизвестен (иначе кнопки на экране всё равно не будет), поэтому две секунды —
 * потолок задержки для карточки клиента, а не для каждой.
 */
const GET_CHAT_TIMEOUT_SECONDS = 2;

/**
 * Коды, на которых повторять сверку в ближайшие сутки бессмысленно: чат боту
 * недоступен. Всё остальное (429, 5xx) — временно, и памятку не заслуживает.
 */
const PERMANENT_CHAT_ERRORS = new Set([400, 403]);

let cachedApi: Api | undefined;

/**
 * Отдельный экземпляр Api, а не общий `getBot()`: тому задан свой транспорт и
 * flood-retry под отправку сообщений клиентам, а здесь нужен короткий поводок и
 * никаких ожиданий в рендере. Транспорт при этом ОБЩИЙ — URL Bot API собирает
 * grammY, своего адреса модуль не строит.
 */
function getChatApi(token: string): Api {
  cachedApi ??= new Api(token, { timeoutSeconds: GET_CHAT_TIMEOUT_SECONDS });
  return cachedApi;
}

/** Только для тестов: сбросить экземпляр между случаями. */
export function resetClientUsernameApiForTests(): void {
  cachedApi = undefined;
}

export type ClientUsernameInput = {
  userId: string;
  telegramId: string | null;
  telegramUsername: string | null;
  telegramUsernameCheckedAt: Date | null;
};

/**
 * Возвращает username клиента (без `@`) или `null`.
 *
 * Ждём Telegram, только если известного имени нет: тогда от ответа зависит,
 * будет ли на экране кнопка. Если имя известно, а сверка протухла — карточка
 * рисуется сразу, а сверка уходит в фон и поправит значение к следующему
 * открытию (страница и так обновляется сама).
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

  if (known) {
    // Имя есть — экран не ждёт: сверяем в фоне.
    runLater(async () => {
      await syncUsername(token, client, known);
    });
    return known;
  }
  return await syncUsername(token, client, known);
}

function needsRecheck(checkedAt: Date | null, now: Date): boolean {
  if (!checkedAt) return true;
  return now.getTime() - checkedAt.getTime() > USERNAME_RECHECK_AFTER_MS;
}

/**
 * Один заход в Telegram и запись результата. Возвращает то, что показывать.
 *
 * Три исхода различаются намеренно:
 *   - Telegram ответил именем → пишем имя (авторитетно, в том числе пустое);
 *   - Telegram ответил ОТКАЗОМ по существу (400 «chat not found», 403) → имя не
 *     трогаем (отказ не значит «username сняли»), но памятку ставим: иначе
 *     клиент с мёртвым `telegram_id` навсегда добавляет по два поводка к
 *     каждому открытию карточки;
 *   - транспорт (таймаут, обрыв) → не пишем ничего: сверка повторится.
 */
async function syncUsername(
  token: string,
  client: ClientUsernameInput,
  known: string | null,
): Promise<string | null> {
  try {
    const chat = await getChatApi(token).getChat(Number(client.telegramId));
    const raw = 'username' in chat ? chat.username : undefined;
    const fresh = normalizeUsername(raw);
    if (raw && !fresh) {
      // Telegram прислал то, что не похоже на username. Такого быть не должно;
      // стирать по этому известное имя нельзя — оно рабочее, а это аномалия.
      log.warn({ event: 'panel.client_username.unexpected_shape' });
      runLater(async () => {
        await touchCheck(client.userId);
      });
      return known;
    }
    runLater(async () => {
      await persist(client.userId, fresh);
    });
    return fresh;
  } catch (err) {
    if (err instanceof GrammyError && PERMANENT_CHAT_ERRORS.has(err.error_code)) {
      // Ответ по существу: чат недоступен боту. Имя не трогаем, память ставим.
      log.warn({ event: 'panel.client_username.chat_unavailable', code: err.error_code });
      runLater(async () => {
        await touchCheck(client.userId);
      });
      return known;
    }
    if (err instanceof GrammyError) {
      // 429 flood-wait и 5xx — временная авария провайдера, а не «чата нет».
      // Памятку не ставим: иначе у клиента с живым @username кнопка лички
      // пропадала бы на сутки из-за минутного всплеска у Telegram.
      log.warn({ event: 'panel.client_username.lookup_unavailable', code: err.error_code });
      return known;
    }
    // Таймаут или обрыв — ничего не записываем: записать пустоту значило бы
    // погасить рабочую ссылку на сутки по чужой аварии.
    log.warn({ event: 'panel.client_username.lookup_failed', err });
    return known;
  }
}

async function persist(userId: string, username: string | null): Promise<void> {
  try {
    await setTelegramUsername(getDb(), { userId, username });
  } catch (err) {
    log.warn({ event: 'panel.client_username.persist_failed', err });
  }
}

async function touchCheck(userId: string): Promise<void> {
  try {
    await touchTelegramUsernameCheck(getDb(), { userId });
  } catch (err) {
    log.warn({ event: 'panel.client_username.touch_failed', err });
  }
}

/**
 * Побочный эффект — после ответа страницы: рендер карточки не должен ждать
 * запись. Вне запроса (тест, скрипт) `after()` бросает — тогда выполняем
 * синхронно, тем же приёмом, что и аналитика (`lib/analytics/track.ts`), и с
 * такой же записью причины: молчащий фолбэк скрыл бы, что `after()` перестал
 * работать в новом контексте.
 */
function runLater(work: () => Promise<void>): void {
  try {
    after(work);
  } catch (err) {
    log.debug({ event: 'panel.client_username.after_unavailable', err });
    void work();
  }
}
