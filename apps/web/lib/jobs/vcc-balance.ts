import 'server-only';

import * as Sentry from '@sentry/nextjs';

import { getDb } from '@oplati/db';

import { notifyStaff } from '../alerts/notify-staff.ts';
import { serverEnv } from '../env.server.ts';
import { childLogger } from '../logger.ts';
import { orderFundingRequirementUsdCents } from '../pay-space/funding.ts';
import { persistVccBalanceSnapshot } from '../pay-space/snapshot.ts';
import { getPaySpaceClient, isPaySpaceConfigured } from '../pay-space/index.ts';

const log = childLogger('vcc-balance');

/**
 * Алёрт на низкий баланс VCC-аккаунта (фонд под выпуск карт; пополнение T+1 + fee).
 *
 * Вызывается из cron'ов `recycle-cards` (раз в сутки) И `poll-payment` (каждые
 * 5 мин). Частая проверка важна: каждая новая карта списывает `сумма+буфер+$4 fee`,
 * при потоке заказов баланс может уйти в ноль ПОСРЕДИ дня между суточными
 * прогонами recycle, а пополнение приходит только на следующий день (T+1) → каскад
 * заказов в `failed`. Чем раньше предупреждение — тем больше времени пополнить.
 *
 * Это мониторинг: ошибка проверки баланса не должна влиять на основной результат
 * cron'а (ловим и алёртим отдельно, ничего не бросаем наружу).
 *
 * ⚠️ ИСТОРИЯ, из-за которой алёрт устроен именно так (`docs/BACKLOG.md`).
 * 28 июля порог выставили в `0` — то есть выключили молча, потому что правило
 * начало повторяться и забивать канал. 14 августа риск сработал: заказ на
 * 11 680 ₽ упал с `insufficient_sub_balance` ($89.50 при нужных ~$124), и
 * предупредить было нечему. Отсюда четыре требования владельца, и все четыре
 * держатся кодом ниже:
 *
 *   1. доставка В ЛИЧКУ, а не только в Sentry (`notifyStaff` — бот входа);
 *   2. дедуп: критическое — раз в час, предупреждение — раз в сутки; крон
 *      бежит каждые 5 минут, и без окна алёрт умирает второй раз;
 *   3. порог ОТНОСИТЕЛЬНЫЙ — от заказа, который клиент может оформить прямо
 *      сейчас, а не плоское число: $89.50 больше дефолтных $50, и даже со
 *      включённым алёртом предупреждения бы не было. Уровней ДВА, см. ниже;
 *   4. выключение — ЯВНЫМ флагом, а не нулём в пороге, который выглядит как
 *      «настроено».
 */

/**
 * Явный выключатель. `VCC_BALANCE_ALERT_DISABLED=1` — «мы знаем и приняли»;
 * ноль в пороге больше выключением НЕ является: он читался как «настроено».
 */
function isAlertDisabled(): boolean {
  return serverEnv.VCC_BALANCE_ALERT_DISABLED === true;
}

/**
 * Пороги ДВУХ уровней. Один порог этот вопрос не описывает, а выбор между
 * «считать от самого дорогого заказа» и «не шуметь» ложный:
 *
 *   - `critical` — не хватает даже на ТИПОВОЙ заказ ($100 + буфер + fee). Это
 *     авария: следующий же оплаченный заказ упадёт, как 14 августа;
 *   - `low` — не хватает на САМЫЙ дорогой заказ, который клиент может оформить
 *     прямо сейчас (витринный кап $1200). Это не авария, а предупреждение:
 *     держать полторы тысячи долларов на счёте владелец не обязан, но знать,
 *     что крупный заказ сейчас не пройдёт, — да.
 *
 * Разные уровни и шумят по-разному (см. `alertOnLowVccBalance`): критический —
 * раз в час, предупреждение — раз в сутки. Вечно красный алёрт читать
 * перестают, и это уже случалось.
 */
export function vccAlertThresholdsUsdCents(): { critical: number; low: number } {
  // ⚠️ Своей формулы здесь больше НЕТ (тикет 01 трека vcc-preflight). Порог
  // отвечает на вопрос «хватит ли на следующий заказ», а сколько заказ стоит
  // фонду, знает `orderFundingRequirementUsdCents` — она же единственный
  // источник этого числа для остальных потребителей. Держать здесь копию
  // значило бы, что два ответа об одних и тех же деньгах расходятся от правки
  // в одном месте, и ничто при этом не падает.
  // Клиент без карты — худший (и типичный) случай: комиссию за выпуск считаем.
  const requirementFor = (usdCents: number) =>
    orderFundingRequirementUsdCents({ priceUsdCents: usdCents, needsNewCard: true });

  // Явно заданный порог — это право владельца назвать свою цифру; тогда он и
  // есть критический уровень.
  // ⚠️ Явно заданный порог ОТМЕНЯЕТ второй уровень: владелец, назвавший свою
  // цифру, получает ровно её. Иначе он всё равно ловил бы предупреждение о
  // недостижимом для себя $1444 и шёл выключать алёрт целиком — то есть код
  // подталкивал бы ровно к тому, чего тикет избегает.
  const explicit = serverEnv.PAYSPACE_MIN_VCC_BALANCE_USD_CENTS;
  if (explicit > 0) return { critical: explicit, low: explicit };
  const critical = requirementFor(TYPICAL_ORDER_USD_CENTS);
  return { critical, low: Math.max(critical, requirementFor(MAX_ORDER_USD_CENTS)) };
}

/**
 * Типовой заказ ($100) и витринный кап ($1200).
 *
 * ⚠️ Кап — зеркало `HIGH_VALUE_SERVICE_SLUGS` (инвариант 10). Держим числом
 * ЗДЕСЬ осознанно: тянуть каталог из базы ради порога алёрта значит поставить
 * мониторинг в зависимость от той самой базы, за которой он следит.
 */
const TYPICAL_ORDER_USD_CENTS = 10_000;
const MAX_ORDER_USD_CENTS = 120_000;

/** Ключ дедупа предупреждения — с датой: не чаще раза в сутки. */
function dailyKey(now: Date): string {
  return `vcc_balance_low:${now.toISOString().slice(0, 10)}`;
}

export async function alertOnLowVccBalance(now: Date = new Date()): Promise<void> {
  if (!isPaySpaceConfigured()) return;

  // ⚠️ Выключатель алёрта гасит СООБЩЕНИЯ, а не опрос. Раньше он стоял выше и
  // выходил до запроса — после тикета 03 это тихо ломало бы гейт оплаты:
  // снимок фонда перестал бы обновляться, и каждая оплата снова ходила бы к
  // провайдеру. Флаг называется «алёрт выключен», им он и остаётся.
  const alertDisabled = isAlertDisabled();
  if (alertDisabled) log.debug({ event: 'vcc_balance.alert_disabled' });

  try {
    // ⚠️ Расчёт порога — ВНУТРИ try. Он больше не инлайн-арифметика: формула
    // требования валидирует вход и умеет бросить, а этот модуль обещает, что
    // сбой наблюдателя не роняет наблюдаемое (крон опроса платежей).
    const { critical, low } = vccAlertThresholdsUsdCents();
    const { balanceUsdCents, pendingUsdCents } = await getPaySpaceClient().getVccBalance();

    // Снимок пишется ВСЕГДА, а не только при низком балансе: гейт оплаты
    // (`lib/pay-space/preflight.ts`) читает именно нормальное значение — по
    // нему он пропускает счёт, не ходя к провайдеру. Крон и так спрашивал
    // баланс каждые 5 минут и выбрасывал ответ.
    await persistVccBalanceSnapshot(getDb(), { balanceUsdCents, pendingUsdCents, readAt: now }, 'cron');

    if (alertDisabled) return;

    if (balanceUsdCents >= low) {
      log.info({ event: 'vcc_balance.ok', balanceUsdCents });
      return;
    }

    const isCritical = balanceUsdCents < critical;
    const threshold = isCritical ? critical : low;
    log.warn({ event: 'vcc_balance.low', balanceUsdCents, threshold, critical: isCritical });

    const usd = (cents: number) => (cents / 100).toFixed(2);
    const res = await notifyStaff(
      isCritical
        ? `Критически мало на карточном счёте PaySpace: ${usd(balanceUsdCents)} USD. ` +
            `На типовой заказ нужно ${usd(critical)} USD — следующий оплаченный заказ ` +
            `упадёт при выпуске карты, а пополнение приходит только на следующий день.`
        : `На карточном счёте PaySpace ${usd(balanceUsdCents)} USD: на типовой заказ хватает, ` +
            `на самый дорогой (нужно ${usd(low)} USD) — нет. Пополнение приходит T+1.`,
      // Критическое — раз в час, предупреждение — раз в сутки: вечно
      // повторяющееся сообщение перестают читать, и алёрт умирает второй раз.
      {
        dedupKey: isCritical ? 'vcc_balance_critical' : dailyKey(now),
        // ⚠️ Окно ЗАДАЁТСЯ явно. Ключ с датой сам по себе суток не держит:
        // окно у экземпляра одно, и через час тот же ключ снова свободен —
        // менеджер получил бы два десятка одинаковых DM в сутки о нормальном
        // и длительном состоянии.
        dedupWindowMs: isCritical ? undefined : 24 * 60 * 60 * 1000,
        capability: 'holds',
      },
    );

    // ⚠️ Sentry — ПОД ТЕМ ЖЕ дедупом, что и личка. Без этого крон писал бы
    // событие каждые 5 минут (288 в сутки) в общий проект с общими правилами
    // алертов — то есть чинили бы канал в Telegram, а топили Sentry.
    if (!res.deduped) {
      Sentry.captureMessage('PaySpace VCC balance низкий — пополнить (T+1)', {
        level: isCritical ? 'error' : 'warning',
        tags: { source: 'vcc-balance', alert: 'low_vcc_balance' },
        extra: { balanceUsdCents, threshold, critical: isCritical },
      });
    }
  } catch (err) {
    log.error({ event: 'vcc_balance.check_error', err });
    Sentry.captureException(err, { tags: { source: 'vcc-balance', step: 'balance' } });
  }
}
