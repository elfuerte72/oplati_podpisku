import 'server-only';

import * as Sentry from '@sentry/nextjs';

import { vccAlertThresholdsUsdCents } from '@/lib/jobs/vcc-balance';
import { childLogger } from '@/lib/logger';
import { getPaySpaceClient, isPaySpaceConfigured } from '@/lib/pay-space';

/**
 * Остаток на карточном счёте PaySpace — на видном месте панели (тикет 05).
 *
 * Зачем: 14 августа его нехватка уронила уже оплаченный заказ на 11 680 ₽
 * (нужно было ~$124, лежало $89.50). Пополнение приходит T+1, поэтому ценность
 * не в самом числе, а в том, чтобы увидеть его ЗАРАНЕЕ.
 *
 * ⚠️ Порог считается ТОЙ ЖЕ функцией, что питает алёрт
 * (`vccAlertThresholdsUsdCents` в `lib/jobs/vcc-balance.ts`), а не читается из
 * env напрямую. Своё чтение переменной означало бы, что экран и алёрт спорят о
 * том, когда бить тревогу: тикет 11 переопределил `0` как «считать
 * относительно», и панель с прежним «0 = выключено» показывала бы «всё
 * спокойно» при нулевом счёте — ровно в тот момент, когда крон уже кричит.
 *
 * ⚠️ Никогда не бросает: недоступный провайдер — это «баланс не получен» на
 * экране, а не пятисотка вместо списка холдов.
 */

const log = childLogger('panel.vcc-balance');

/**
 * Бюджет ОДНОЙ фазы таймера клиента (заголовки, затем тело), заходов — один.
 * Потолок ожидания страницы, значит, вдвое больше этого числа.
 *
 * Зачем свой: дефолт клиента — 60 с на фазу и два захода, то есть до четырёх
 * минут. Такая цена оправдана при выпуске карты (рубли уже приняты), но не на
 * экране, где баланс — справочная строка рядом с холдами.
 */
const BALANCE_TIMEOUT_MS = 3000;

/**
 * Сколько живёт удачно прочитанное значение.
 *
 * Экран холдов обновляется сам раз в 25 секунд (`LiveRefresh`), то есть одна
 * открытая вкладка без кэша била бы в чужой API 144 раза в час — ради числа,
 * которое меняется при пополнении раз в сутки (T+1). Кэш убирает и это, и
 * поток одинаковых отказов при медленном провайдере.
 */
const BALANCE_CACHE_TTL_MS = 60_000;

/** Насколько старое значение ещё имеет смысл показывать вместо прочерка. */
const BALANCE_STALE_MAX_MS = 30 * 60_000;

export type PanelVccBalanceReading = {
  balanceUsdCents: number;
  pendingUsdCents: number;
  /** Критический порог — тот же, что у алёрта. */
  thresholdUsdCents: number;
  low: boolean;
  /** Когда значение реально получено от провайдера. */
  readAt: Date;
};

export type PanelVccBalance =
  | ({ state: 'ok' } & PanelVccBalanceReading)
  /**
   * Свежее значение получить не удалось, но недавнее есть. Показываем ЕГО с
   * пометкой: экран заводился ради того, чтобы увидеть нехватку заранее, и
   * «баланс не получен» вместо числа — ровно потеря этой возможности.
   */
  | ({ state: 'stale' } & PanelVccBalanceReading)
  | { state: 'not_configured' }
  | { state: 'unavailable' };

type CachedReading = { balanceUsdCents: number; pendingUsdCents: number; readAt: number };

let cached: CachedReading | null = null;

/** Только для тестов: сбросить кэш между сценариями. */
export function resetVccBalanceCacheForTests(): void {
  cached = null;
}

export async function readVccBalanceForPanel(now: Date = new Date()): Promise<PanelVccBalance> {
  if (!isPaySpaceConfigured()) return { state: 'not_configured' };

  // Подсвечиваем по КРИТИЧЕСКОМУ уровню: «не хватает на типовой заказ» —
  // это состояние, требующее действия сегодня. Второй уровень (не хватает на
  // самый дорогой заказ) нормален и длителен, и красить им экран целый день
  // значит приучить смотреть мимо.
  const thresholdUsdCents = vccAlertThresholdsUsdCents().critical;
  const nowMs = now.getTime();

  if (cached && nowMs - cached.readAt < BALANCE_CACHE_TTL_MS) {
    return reading('ok', cached, thresholdUsdCents);
  }

  try {
    const { balanceUsdCents, pendingUsdCents } = await getPaySpaceClient().getVccBalance({
      timeoutMs: BALANCE_TIMEOUT_MS,
      attempts: 1,
    });
    cached = { balanceUsdCents, pendingUsdCents, readAt: nowMs };
    return reading('ok', cached, thresholdUsdCents);
  } catch (err) {
    // ⚠️ Сигналим ИЗБИРАТЕЛЬНО. Таймаут и сетевой сбой на этом пути — обычное
    // «провайдер сегодня медленный», а страница живая: `captureException` на
    // каждом отказе давал бы сотню Sentry-ошибок в час с одной вкладки. Именно
    // так был заглушён алёрт баланса в прошлый раз, и об этом же предупреждает
    // запись в `docs/BACKLOG.md`. В Sentry уходит НЕОЖИДАННОЕ — дрейф контракта
    // и отказ самого провайдера; про нехватку денег кричит крон-алёрт, а не
    // экран.
    if (isSlowProviderError(err)) {
      log.warn({ event: 'panel.vcc_balance.slow', timeoutMs: BALANCE_TIMEOUT_MS });
    } else {
      log.warn({ event: 'panel.vcc_balance.unavailable', err });
      Sentry.captureException(err, { tags: { source: 'panel.vcc-balance' } });
    }

    if (cached && nowMs - cached.readAt < BALANCE_STALE_MAX_MS) {
      return reading('stale', cached, thresholdUsdCents);
    }
    return { state: 'unavailable' };
  }
}

function reading(
  state: 'ok' | 'stale',
  value: CachedReading,
  thresholdUsdCents: number,
): PanelVccBalance {
  return {
    state,
    balanceUsdCents: value.balanceUsdCents,
    pendingUsdCents: value.pendingUsdCents,
    thresholdUsdCents,
    low: value.balanceUsdCents < thresholdUsdCents,
    readAt: new Date(value.readAt),
  };
}

/**
 * «Провайдер не успел» — это наш собственный дедлайн (AbortError) или обрыв
 * транспорта. Отличается от «провайдер ответил ошибкой» и от дрейфа контракта:
 * те требуют человека, а этот — терпения.
 */
function isSlowProviderError(err: unknown): boolean {
  if (err instanceof Error && err.name === 'AbortError') return true;
  return err instanceof TypeError && /fetch failed|terminated|network|socket/i.test(err.message);
}
