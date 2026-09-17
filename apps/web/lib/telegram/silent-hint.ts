import 'server-only';

import { InlineKeyboard } from 'grammy';

import { claimOnce, releaseClaim } from '@/lib/dedup';
import { serverEnv } from '@/lib/env.server';

import { botIdFromToken } from './bot';
import { START_SUPPORT_BUTTON } from './templates';

/**
 * Дедуп подсказки «бот не молчит» (тикет 09 админ-панели).
 *
 * При выключенном `BOT_AI_ENABLED` бот отвечает одной фразой на свободный текст
 * и на медиа. Без дедупа это превращается в спам: Telegram шлёт апдейт на
 * КАЖДОЕ фото альбома (до десяти за раз), а человек, которому не ответили по
 * делу, обычно пишет несколько сообщений подряд.
 *
 * Эшелона два, и это не перестраховка:
 *   - Redis (`claimOnce`) — общий для всех процессов, но **fail-open**: не
 *     настроен, упал или завис → «право взято». То есть ровно там, где Redis
 *     нет (dev-стенд) или он в аварии, альбом снова дал бы десять подсказок;
 *   - память процесса — закрывает этот случай. Альбом приходит подряд и почти
 *     всегда в один контейнер, поэтому локального окна достаточно.
 *
 * Направление отказа осознанно разное с дедупом апдейтов (`lib/dedup.ts`): там
 * потерять апдейт хуже, чем обработать дважды, здесь наоборот — лишняя
 * подсказка дешевле молчания, но десять подряд превращают бота в спамера.
 */

/**
 * Окно, в течение которого второй подсказки не будет. Час: столько живёт
 * ситуация «человек пишет боту и не понимает, почему тишина». Меньше — и серия
 * сообщений в разговорном темпе снова даст несколько подсказок; больше — и
 * вернувшийся через полдня клиент опять уйдёт в тишину.
 */
export const SILENT_HINT_TTL_SECONDS = 3600;

/**
 * Локальный эшелон: identity → до какого времени (мс) подсказка уже отправлена.
 *
 * Потолок — защита от роста на потоке уникальных отправителей. При переполнении
 * сначала выбрасываем протухшее, и только если это не помогло — очищаем всё:
 * ограниченная память важнее точности дедупа (худшее следствие — одна лишняя
 * подсказка).
 */
const memory = new Map<string, number>();
const MEMORY_MAX_ENTRIES = 10_000;

/**
 * `true` — подсказку отправляем, `false` — уже отправляли в этом окне.
 * Никогда не бросает (внутри — `claimOnce`, который сам не бросает).
 */
export async function claimSilentHint(
  identity: string,
  now: number = Date.now(),
): Promise<boolean> {
  return claimTwoTier(memory, 'hint', identity, SILENT_HINT_TTL_SECONDS, now);
}

/**
 * Двухэшелонный claim окна: память процесса, затем Redis. Один на подсказку и
 * альбом — вторая копия разъехалась бы в самом неочевидном месте (порядок
 * эшелонов, чистка памяти).
 *
 * Локальное окно занимается СИНХРОННО, до похода в Redis. Иначе десять
 * апдейтов альбома, пришедших параллельно (Telegram шлёт их пачкой, а Next
 * обрабатывает конкурентно), все успевают пройти проверку до первой записи —
 * и весь дедуп ложится на Redis, который здесь fail-open. То есть ровно в
 * сценарии, ради которого локальный эшелон и написан, он бы не работал.
 *
 * Окно помнится и когда Redis ответит «занято»: значит право уже взял соседний
 * процесс, и переспрашивать его на каждое фото альбома незачем.
 */
async function claimTwoTier(
  local: Map<string, number>,
  kind: 'hint' | 'album',
  id: string,
  ttlSeconds: number,
  now: number,
): Promise<boolean> {
  const blockedUntil = local.get(id);
  if (blockedUntil !== undefined && blockedUntil > now) return false;
  if (local.size >= MEMORY_MAX_ENTRIES) prune(local, now);
  local.set(id, now + ttlSeconds * 1000);
  return claimOnce(claimKey(kind, id), ttlSeconds);
}

/**
 * Вернуть право: сообщение так и не ушло (Telegram ответил ошибкой).
 *
 * Без этого несостоявшаяся отправка запирала подсказку на час — то есть
 * возвращала ровно ту тишину, ради устранения которой тикет 09 и делался.
 * Ключ в Redis снимаем тоже: соседний процесс должен получить право попробовать.
 */
export async function releaseSilentHint(identity: string): Promise<void> {
  memory.delete(identity);
  await releaseClaim(claimKey('hint', identity));
}

/** Ключ несёт id бота: иначе прод и dev гасят подсказки и альбомы друг друга. */
function claimKey(kind: 'hint' | 'album', id: string): string {
  return `tg:${kind}:${botIdFromToken(serverEnv.TELEGRAM_BOT_TOKEN)}:${id}`;
}

function prune(local: Map<string, number>, now: number): void {
  for (const [key, expiresAt] of local) {
    if (expiresAt <= now) local.delete(key);
  }
  if (local.size >= MEMORY_MAX_ENTRIES) local.clear();
}

/**
 * Клавиатура под подсказкой: ровно одна кнопка «Поддержка» на СУЩЕСТВУЮЩИЙ
 * callback `support`. Второго входа в поддержку не заводим — обращение
 * по-прежнему создаётся только нажатием, и обрабатывает его тот же флоу, что
 * кнопку в `/start`-меню.
 */
export function buildSupportHintKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text(START_SUPPORT_BUTTON, 'support');
}

/** Только для тестов: сбросить память процесса между сценариями. */
export function __resetSilentHintMemory(): void {
  memory.clear();
}

/** Только для тестов: размер памяти процесса (проверка потолка). */
export function __silentHintMemorySize(): number {
  return memory.size;
}

/**
 * Первый ли это апдейт альбома? `true` — обрабатываем, `false` — хвост альбома.
 *
 * Telegram шлёт ОТДЕЛЬНЫЙ апдейт на каждое фото альбома с общим
 * `media_group_id`. Без этой проверки альбом из десяти кадров означал бы
 * десять походов в БД (upsert клиента, поиск разговора, чтение режима), десять
 * строк «[фото]» в переписке и десять уведомлений персоналу — и это в том же
 * процессе, что принимает вебхуки платежей.
 *
 * Эшелона два — тем же приёмом, что у подсказки (crm-serious-fixes, тикет 04):
 *   - память процесса занимается СИНХРОННО и первой: апдейты альбома приходят
 *     пачкой и обрабатываются конкурентно, а Redis fail-open — без локального
 *     эшелона при его аварии альбом снова давал бы строку на каждый кадр;
 *   - Redis — на случай, когда кадры одного альбома разъехались по процессам.
 *
 * Никогда не бросает (`claimOnce` сам не бросает).
 */
const albums = new Map<string, number>();
const ALBUM_TTL_SECONDS = 60;

export async function claimMediaGroup(groupId: string, now: number = Date.now()): Promise<boolean> {
  return claimTwoTier(albums, 'album', groupId, ALBUM_TTL_SECONDS, now);
}

/** Только для тестов: сбросить память альбомов между сценариями. */
export function __resetMediaGroupMemory(): void {
  albums.clear();
}
