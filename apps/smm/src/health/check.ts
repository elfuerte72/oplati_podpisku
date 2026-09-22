import { z } from 'zod';

import { fetchJson, type HttpOptions } from '../sources/http.ts';
import type { Store } from '../store/index.ts';

/**
 * Проверка здоровья бота: что именно сломано, а не «всё плохо».
 *
 * Список родился из инцидента 08.09.2026: счёт у провайдера модели ушёл в
 * минус посреди прогона, и бот молча перестал писать посты — ни одного
 * сигнала не было. Поэтому баланс проверяется ОТДЕЛЬНО от доступности ключа.
 */

export type HealthLevel = 'green' | 'red';

export interface HealthItem {
  readonly name: string;
  readonly level: HealthLevel;
  /** Почему красно. У зелёного — короткая справка, что именно проверено. */
  readonly reason: string;
}

export interface HealthStatus {
  readonly level: HealthLevel;
  readonly items: readonly HealthItem[];
}

/** Ниже этой суммы на счету провайдера — красно: прогон встанет посреди дня. */
export const MODEL_BALANCE_FLOOR_USD = 1;

/** Пост, застрявший в работе дольше этого, — признак зависшего конвейера. */
export const STUCK_GENERATING_MINUTES = 15;

const BalanceSchema = z.object({
  is_available: z.boolean().optional(),
  balance_infos: z
    .array(
      z.object({
        currency: z.string().optional(),
        total_balance: z.union([z.string(), z.number()]).optional(),
      }),
    )
    .default([]),
});

export interface HealthDeps {
  readonly store: Store;
  /** Чей диалог проверяем на зависание: у бота один владелец. */
  readonly ownerId: number;
  /**
   * Идёт ли приём команд. ⚠️ Отдельно от «бот отвечает»: `getMe` работает и у
   * глухого процесса, чей цикл `getUpdates` остановился на 409 при выкате.
   */
  readonly polling?: { readonly running: boolean; readonly reason?: string };
  /** Проверка бота: `getMe` со своим коротким поводком. */
  readonly checkBot: () => Promise<{ ok: boolean; message?: string }>;
  readonly modelApiKey?: string;
  readonly modelBalanceUrl?: string;
  readonly tavilyApiKey?: string;
  readonly http?: Pick<HttpOptions, 'fetcher' | 'resolver'>;
  readonly now?: () => Date;
}

/**
 * Баланс в ДОЛЛАРАХ. ⚠️ Валюта проверяется: у провайдера бывает счёт в юанях,
 * и семь юаней, прочитанные как семь долларов, — это ровно тот инцидент, ради
 * которого проверка и написана.
 */
export function parseBalanceUsd(value: unknown): number | undefined {
  const parsed = BalanceSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const usd = parsed.data.balance_infos.find(
    (info) => (info.currency ?? '').toUpperCase() === 'USD',
  );
  if (usd?.total_balance === undefined) return undefined;
  const amount = typeof usd.total_balance === 'number' ? usd.total_balance : Number(usd.total_balance);
  return Number.isFinite(amount) ? amount : undefined;
}

async function checkModel(deps: HealthDeps): Promise<HealthItem> {
  if (deps.modelApiKey === undefined || deps.modelApiKey === '') {
    return { name: 'Модель', level: 'red', reason: 'ключ модели не задан' };
  }
  const answer = await fetchJson<unknown>(deps.modelBalanceUrl ?? 'https://api.deepseek.com/user/balance', {
    ...(deps.http?.fetcher === undefined ? {} : { fetcher: deps.http.fetcher }),
    ...(deps.http?.resolver === undefined ? {} : { resolver: deps.http.resolver }),
    headers: { authorization: `Bearer ${deps.modelApiKey}` },
  });
  if (!answer.ok) {
    return { name: 'Модель', level: 'red', reason: `баланс не прочитался: ${answer.reason}` };
  }
  const available = BalanceSchema.safeParse(answer.value);
  if (available.success && available.data.is_available === false) {
    // Провайдер сам говорит «счётом пользоваться нельзя»: спорить с ним по
    // сумме незачем.
    return { name: 'Модель', level: 'red', reason: 'провайдер отвечает: счёт недоступен' };
  }
  const balance = parseBalanceUsd(answer.value);
  if (balance === undefined) {
    return {
      name: 'Модель',
      level: 'red',
      reason: 'баланса в долларах в ответе нет (счёт в другой валюте или дрейф контракта)',
    };
  }
  if (balance < MODEL_BALANCE_FLOOR_USD) {
    return {
      name: 'Модель',
      level: 'red',
      // Отрицательный баланс — это уже остановка, а не предупреждение.
      reason: `на счету $${balance.toFixed(2)} — прогон встанет`,
    };
  }
  return { name: 'Модель', level: 'green', reason: `на счету $${balance.toFixed(2)}` };
}

export async function check(deps: HealthDeps): Promise<HealthStatus> {
  const now = deps.now ?? ((): Date => new Date());
  const at = now();
  const items: HealthItem[] = [];

  const bot = await deps.checkBot();
  items.push(
    bot.ok
      ? { name: 'Бот', level: 'green', reason: 'Telegram отвечает' }
      : { name: 'Бот', level: 'red', reason: bot.message ?? 'Telegram не отвечает' },
  );

  if (deps.polling !== undefined) {
    items.push(
      deps.polling.running
        ? { name: 'Приём команд', level: 'green', reason: 'long polling идёт' }
        : {
            name: 'Приём команд',
            level: 'red',
            reason: `бот не принимает команды: ${deps.polling.reason ?? 'причина неизвестна'}`,
          },
    );
  }

  items.push(await checkModel(deps));

  items.push(
    deps.tavilyApiKey === undefined || deps.tavilyApiKey === ''
      ? { name: 'Поиск', level: 'green', reason: 'ключ Tavily не задан: поиск по теме выключен' }
      : { name: 'Поиск', level: 'green', reason: 'ключ Tavily задан' },
  );

  try {
    // Запрос живёт в хранилище: правило «SQL только в src/store» держит
    // канарейка, и сторож здоровья исключением из него не является.
    const alive = deps.store.ping();
    items.push(
      alive
        ? { name: 'База', level: 'green', reason: 'отвечает' }
        : { name: 'База', level: 'red', reason: 'не отвечает' },
    );
  } catch (error) {
    items.push({ name: 'База', level: 'red', reason: `не отвечает: ${String(error)}` });
  }

  // ⚠️ Зависшим считается ДИАЛОГ в состоянии «собираю», а не пост в статусе
  // `draft`. Пост живёт в `draft` всё время, пока бот ждёт от владельца
  // рубрику и угол, а срок ожидания — сутки: по статусу «красно» загоралось
  // бы на нормальном ожидании человека, и «снова зелено» не приходило бы
  // никогда. Конвейер же в `post.generating` дольше четверти часа — это уже
  // зависший шаг.
  const flow = deps.store.flow.get(deps.ownerId);
  const generatingSince =
    flow?.state === 'post.generating' ? new Date(flow.updatedAt).getTime() : undefined;
  const stuckMinutes =
    generatingSince === undefined ? 0 : (at.getTime() - generatingSince) / (60 * 1000);
  items.push(
    stuckMinutes < STUCK_GENERATING_MINUTES
      ? { name: 'Очередь', level: 'green', reason: 'конвейер не завис' }
      : {
          name: 'Очередь',
          level: 'red',
          reason: `шаг конвейера идёт ${Math.round(stuckMinutes)} минут при потолке ${STUCK_GENERATING_MINUTES}`,
        },
  );

  const pending = deps.store.posts.publishPending();
  const late = pending.filter((post) => post.publishAt !== undefined && post.publishAt < at.toISOString());
  items.push(
    late.length === 0
      ? { name: 'Публикация', level: 'green', reason: 'просроченных публикаций нет' }
      : {
          name: 'Публикация',
          level: 'red',
          // Срок вышел, а пост всё ещё ждёт: таймер не сработал, и без
          // перезапуска он не сработает уже никогда.
          reason: `постов с истёкшим окном отмены: ${late.length}`,
        },
  );

  return {
    level: items.some((item) => item.level === 'red') ? 'red' : 'green',
    items,
  };
}
