import 'server-only';

import * as Sentry from '@sentry/nextjs';

import {
  appendOrderEvent,
  findActiveByUserId,
  getDb,
  getVccBalanceSnapshot,
  PAYMENT_BLOCKED_CAPACITY_EVENT,
  VCC_SNAPSHOT_PROVIDER,
  type DBLike,
} from '@oplati/db';

import { DedupWindow } from '../alerts/dedup-window.ts';
import { notifyStaff } from '../alerts/notify-staff.ts';
import { serverEnv } from '../env.server.ts';
import { childLogger } from '../logger.ts';
import { usdCentsToDollarString } from './format.ts';
import { isCardReusable, orderFundingRequirementUsdCents } from './funding.ts';
import { getPaySpaceClient, isPaySpaceConfigured } from './index.ts';
import { persistVccBalanceSnapshot } from './snapshot.ts';

/**
 * Preflight карточного фонда: можно ли выставлять счёт по этому заказу.
 *
 * Порядок операций до этого гейта был такой: клиент платит -> деньги у нас ->
 * идём в PaySpace -> на субаккаунте не хватает -> заказ в `failed`, деньги
 * приняты, услуга не оказана. Так упали 4 заказа из 17 оплаченных, последний —
 * 14 августа на 11 680 ₽ (нужно было $124, лежало $89.50). Пополнение
 * субаккаунта приходит T+1, поэтому окно уязвимости — сутки, а не минуты.
 *
 * Отказ ДО приёма денег стоит несравнимо дешевле, чем разбор после.
 */

const log = childLogger('pay-space.preflight');

/**
 * Поводок живого запроса к провайдеру: 2 секунды, один заход.
 *
 * Это горячий путь оплаты — клиент стоит и смотрит на кнопку. Дефолт клиента
 * PaySpace (60 с на фазу, два захода) держал бы его до четырёх минут ради
 * справочного числа, а неизвестный ответ мы и так трактуем в пользу оплаты.
 */
const BALANCE_TIMEOUT_MS = 2000;

/**
 * До какого возраста снимок считается свежим.
 *
 * ⚠️ **Зеркало** (инвариант 10) с кадансом крона в `infra/crontab.example`:
 * окно осмысленно, пока опрос идёт заметно чаще получаса. Перевод крона на
 * час тихо вернёт живой запрос к провайдеру в каждую оплату — правишь
 * расписание, проверь это число.
 *
 * Крон опрашивает баланс каждые 5 минут, поэтому протухший снимок означает
 * «крон мёртв или контейнер только что поднялся» — редкий случай, за который
 * клиент не должен платить ожиданием, отсюда и короткий поводок живого запроса.
 *
 * Полчаса не приблизительны, а точны в безопасную сторону: баланс меняется от
 * НАШИХ выпусков карт (видны в наших же заказах мгновенно) и от пополнений
 * владельцем (редких, идущих T+1). Значит снимок ошибается только «в меньшую
 * сторону», и цена ошибки — один лишний отказ, который пройдёт после
 * ближайшего прогона крона.
 */
const SNAPSHOT_FRESH_MS = 30 * 60 * 1000;

/**
 * Окно молчания про непрочитанный фонд. Лежащий провайдер — состояние
 * длительное, и сообщение на каждого клиента превратило бы личку в ленту;
 * ровно так перестают читать алёрты.
 */
const UNKNOWN_ALERT_WINDOW_MS = 60 * 60 * 1000;

const unknownDedup = new DedupWindow(UNKNOWN_ALERT_WINDOW_MS);

/**
 * Окно молчания про отказ клиенту.
 *
 * Короче, чем у непрочитанного фонда: это не «скоро будет плохо», а «прямо
 * сейчас развернули живого клиента с деньгами» — владельцу надо успеть
 * пополнить счёт, а пополнение идёт T+1.
 *
 * ⚠️ Ключ ОДИН на все заказы, а не по `order.id` (в отличие от гейта телефона,
 * где причина у каждого клиента своя). Причина здесь общая — пустой фонд:
 * десять клиентов упрутся в неё десять раз, и десять одинаковых сообщений
 * ничего не добавят к первому, кроме шума.
 */
const BLOCKED_ALERT_WINDOW_MS = 15 * 60 * 1000;

const blockedDedup = new DedupWindow(BLOCKED_ALERT_WINDOW_MS);

/** Только для тестов. */
export function resetPreflightDedupForTests(): void {
  unknownDedup.resetForTests();
  blockedDedup.resetForTests();
}

/**
 * Явный выключатель гейта. `PAYSPACE_PREFLIGHT_DISABLED=1` — «знаем и приняли».
 *
 * ⚠️ Отдельным флагом, а не нулём в каком-нибудь пороге: прецедент
 * `VCC_BALANCE_ALERT_DISABLED` — ноль читался как «настроено» и молча выключил
 * алёрт баланса на месяц, ровно до инцидента, который он должен был предупредить.
 */
function isPreflightDisabled(): boolean {
  return serverEnv.PAYSPACE_PREFLIGHT_DISABLED === true;
}

/** Заказ глазами гейта: больше ему знать не нужно. */
export type PreflightOrder = {
  id: string;
  shortId: string;
  userId: string;
  /** Цена сервиса в USD-центах (`orders.original_amount`); колонка nullable. */
  originalAmount: number | null;
  /** Сумма к оплате в копейках — только чтобы назвать её владельцу в DM. */
  amountRub: number | null;
};

/** «на 11 680 ₽» — владельцу важен масштаб развёрнутого заказа, а не только id. */
function amountRubNote(order: PreflightOrder): string {
  if (!order.amountRub || order.amountRub <= 0) return '';
  return ` на ${(order.amountRub / 100).toLocaleString('ru-RU')} ₽`;
}

export type FundingCapacityVerdict =
  /** Фонда хватает — счёт выставляем. */
  | { state: 'ok' }
  /** Фонда заведомо нет: счёт не выставляем, заказ не трогаем. */
  | { state: 'insufficient'; availableUsdCents: number; neededUsdCents: number }
  /**
   * Гейт не работает: провайдер не настроен, выключен флагом или считать нечего.
   * Чем именно — видно в логах; вызывающему важно одно: счёт выставляем.
   */
  | { state: 'skipped' }
  /**
   * Фонд прочитать не удалось — оплату ПРОПУСКАЕМ (спека Р5, решение В2).
   *
   * Fail-open здесь осознан: до этого гейта проверки не было вовсе, значит он
   * не хуже статус-кво, а fail-closed означал бы, что чужой сбой останавливает
   * нам продажи целиком. Владелец узнаёт отдельным сообщением.
   */
  | { state: 'unknown' };

export async function checkOrderFundingCapacity(
  order: PreflightOrder,
  now: Date = new Date(),
): Promise<FundingCapacityVerdict> {
  if (isPreflightDisabled()) {
    log.warn({ event: 'preflight.disabled', orderId: order.id });
    return { state: 'skipped' };
  }

  // ⚠️ `original_amount` — nullable колонка. Пустая цена не значит «фонда нет»:
  // такой заказ и выпустить-то нельзя, его поймает `issue-card` со своим
  // `invalid_amount`. Здесь важно не превратить пустое поле в пятисотку вместо
  // платёжной ссылки — формула требования на невалидном входе БРОСАЕТ, и это
  // правильно, но не в горячем пути оплаты.
  const priceUsdCents = order.originalAmount;
  if (priceUsdCents === null || !Number.isInteger(priceUsdCents) || priceUsdCents <= 0) {
    log.warn({ event: 'preflight.no_price', orderId: order.id, priceUsdCents });
    return { state: 'skipped' };
  }

  const db = getDb();

  // Комиссию за выпуск платим только когда карту придётся выпускать: у клиента
  // с живой картой заказ дешевле фонду ровно на неё. Правило реюза — общее с
  // `issue-card` (`isCardReusable`), иначе гейт и выпуск ответили бы по-разному.
  const needsNewCard = !isCardReusable(await findActiveByUserId(db, order.userId));
  const neededUsdCents = orderFundingRequirementUsdCents({ priceUsdCents, needsNewCard });

  // ⚠️ Берём `balance` (ДОСТУПНЫЙ остаток), а не сумму с `pending`.
  // Замороженными деньгами карту профинансировать нельзя, и пропущенный по ним
  // заказ упал бы на выпуске — то есть вернул бы ровно ту проблему, ради
  // которой этот гейт написан.
  const fund = await readAvailableFund(db, order, now);
  if (!fund.ok) return fund.reason === 'unknown' ? { state: 'unknown' } : { state: 'skipped' };
  const balanceUsdCents = fund.balanceUsdCents;

  if (balanceUsdCents >= neededUsdCents) {
    log.info({
      event: 'preflight.ok',
      orderId: order.id,
      availableUsdCents: balanceUsdCents,
      neededUsdCents,
    });
    return { state: 'ok' };
  }

  log.warn({
    event: 'preflight.insufficient',
    orderId: order.id,
    availableUsdCents: balanceUsdCents,
    neededUsdCents,
    needsNewCard,
  });
  return { state: 'insufficient', availableUsdCents: balanceUsdCents, neededUsdCents };
}

/**
 * Доступный остаток фонда: сначала свой снимок, и только если он протух —
 * один живой запрос к провайдеру.
 *
 * ⚠️ Снимок проверяется ДО ключей провайдера намеренно. На контуре без ключей
 * (dev — там их нет специально) гейт обязан оставаться проверяемым: положил
 * строку снимка в базу руками — и весь путь отказа виден целиком, без единого
 * обращения к PaySpace. Обратный порядок делал бы гейт непроверяемым до прода.
 *
 * `'unavailable'` — спросить некого (ключей нет), это конфигурация, а не сбой:
 * оплата идёт. `'unknown'` — провайдер не ответил; тоже идёт, но с сигналом.
 */
type FundReading =
  | { ok: true; balanceUsdCents: number }
  /** `unknown` — провайдер не ответил; `unavailable` — спрашивать некого. */
  | { ok: false; reason: 'unknown' | 'unavailable' };

async function readAvailableFund(
  db: DBLike,
  order: PreflightOrder,
  now: Date,
): Promise<FundReading> {
  const snapshot = await getVccBalanceSnapshot(db, VCC_SNAPSHOT_PROVIDER);
  // ⚠️ Возраст обязан быть НЕОТРИЦАТЕЛЬНЫМ. Снимок «из будущего» (ушли часы
  // контейнера, строку положили руками со сдвинутым `read_at`) проходил бы
  // проверку «не старше получаса» ВЕЧНО: гейт судил бы по выдуманному числу, а
  // крон, который его перезапишет, до этого момента не дотянется.
  const ageMs = snapshot ? now.getTime() - snapshot.readAt.getTime() : null;
  if (snapshot && ageMs !== null && ageMs >= 0 && ageMs <= SNAPSHOT_FRESH_MS) {
    return { ok: true, balanceUsdCents: snapshot.balanceUsdCents };
  }

  if (!isPaySpaceConfigured()) {
    log.debug({ event: 'preflight.not_configured', orderId: order.id });
    return { ok: false, reason: 'unavailable' };
  }

  // ⚠️ Коалесценции здесь НЕТ: залп оплат по холодному снимку даст по живому
  // запросу на каждую, а не один на всех. При нынешнем потоке (десятки заказов
  // в сутки) это допустимо, и состояние редкое — крон бежит каждые 5 минут.
  // Станет тесно — сюда просится общий замок, а не второй кэш.
  log.info({
    event: 'preflight.snapshot_cold',
    orderId: order.id,
    snapshotReadAt: snapshot?.readAt.toISOString() ?? null,
    snapshotAgeMs: ageMs,
  });
  try {
    const live = await getPaySpaceClient().getVccBalance({
      timeoutMs: BALANCE_TIMEOUT_MS,
      attempts: 1,
    });
    // Пишем сразу: следующий клиент в ближайшие полчаса уже не ждёт провайдера,
    // даже если крон так и не ожил. Ошибку записи гасит сам `persist*` —
    // одинаково с кроном, и одинаково же сигналит.
    await persistVccBalanceSnapshot(
      db,
      {
        balanceUsdCents: live.balanceUsdCents,
        pendingUsdCents: live.pendingUsdCents,
        readAt: now,
      },
      'preflight',
    );
    return { ok: true, balanceUsdCents: live.balanceUsdCents };
  } catch (err) {
    await reportFundingUnknown(order, err);
    return { ok: false, reason: 'unknown' };
  }
}

/**
 * Фонд прочитать не удалось: клиент оплату получает, владелец — сообщение.
 *
 * ⚠️ Sentry живёт ПОД ТЕМ ЖЕ окном, что и личка. Иначе поток клиентов при
 * лежащем провайдере даёт сотни одинаковых событий в общий проект с общими
 * правилами алертов — чинили бы канал в Telegram, а топили Sentry.
 */
async function reportFundingUnknown(order: PreflightOrder, err: unknown): Promise<void> {
  log.error({ event: 'preflight.unknown', orderId: order.id, err });
  if (!unknownDedup.shouldSend('preflight_unknown')) return;

  Sentry.captureException(err, {
    tags: { source: 'pay-space.preflight', step: 'balance' },
    extra: { orderId: order.id },
  });
  try {
    await notifyStaff(
      'Не удалось прочитать карточный счёт PaySpace перед выставлением счёта ' +
        `(заказ ${order.shortId}). Оплату пропустили — если денег на счёте нет, ` +
        'заказ упадёт уже после приёма рублей. Проверь баланс и доступность провайдера.',
      {
        dedupKey: 'preflight_unknown_staff',
        // ⚠️ Окно ЗАДАЁТСЯ явно. У `notifyStaff` своё, дефолтом час: молчи мы
        // о нём, внешнее окно и внутреннее разошлись бы, и Sentry писал бы
        // чаще, чем владелец получает сообщения.
        dedupWindowMs: UNKNOWN_ALERT_WINDOW_MS,
        capability: 'holds',
      },
    );
  } catch (notifyErr) {
    // Доставка алёрта — наблюдатель наблюдателя: её сбой не должен превращать
    // пропущенную оплату в ошибку клиенту.
    log.error({ event: 'preflight.unknown_notify_failed', orderId: order.id, err: notifyErr });
  }
}

/**
 * Отказ состоялся: пишем след в журнал заказа и сообщаем владельцу.
 *
 * Никогда не бросает. Ответ клиенту важнее следа: 500 вместо честного «попробуй
 * позже» — худший исход, чем недописанное событие или недоставленное DM.
 */
export async function reportFundingCapacityBlocked(
  order: PreflightOrder,
  verdict: Extract<FundingCapacityVerdict, { state: 'insufficient' }>,
): Promise<void> {
  const shortfallUsdCents = verdict.neededUsdCents - verdict.availableUsdCents;

  // Событие — на КАЖДЫЙ отказ, вне дедупа: по нему считают, не режет ли гейт
  // живые оплаты, а статус заказа об отказе не говорит ничего (он не меняется).
  try {
    await appendOrderEvent(getDb(), {
      orderId: order.id,
      eventType: PAYMENT_BLOCKED_CAPACITY_EVENT,
      actorType: 'system',
      payload: {
        availableUsdCents: verdict.availableUsdCents,
        neededUsdCents: verdict.neededUsdCents,
        shortfallUsdCents,
      },
    });
  } catch (err) {
    log.error({ event: 'preflight.blocked_event_failed', orderId: order.id, err });
  }

  if (!blockedDedup.shouldSend('preflight_blocked')) return;

  Sentry.captureMessage('Preflight: не хватает карточного фонда — клиент развёрнут', {
    level: 'error',
    tags: { source: 'pay-space.preflight', alert: 'funding_capacity' },
    extra: {
      orderId: order.id,
      availableUsdCents: verdict.availableUsdCents,
      neededUsdCents: verdict.neededUsdCents,
    },
  });
  try {
    await notifyStaff(
      `Клиент не смог оплатить ${order.shortId}${amountRubNote(order)}: ` +
        `на карточном счёте PaySpace ${usdCentsToDollarString(verdict.availableUsdCents)} USD, ` +
        `на этот заказ нужно ${usdCentsToDollarString(verdict.neededUsdCents)} USD — ` +
        `не хватает ${usdCentsToDollarString(shortfallUsdCents)} USD. ` +
        'Счёт клиенту не выставлен, заказ жив с зафиксированной ценой. ' +
        'Пополни карточный счёт — пополнение идёт T+1.',
      {
        // ⚠️ Окно ЗАДАЁТСЯ явно: дефолт `notifyStaff` — ЧАС, и без этой строки
        // личка молчала бы вчетверо дольше Sentry, хотя тикет требует ровно
        // обратного — «Sentry под тем же окном».
        dedupKey: 'preflight_blocked_staff',
        dedupWindowMs: BLOCKED_ALERT_WINDOW_MS,
        capability: 'holds',
      },
    );
  } catch (err) {
    log.error({ event: 'preflight.blocked_notify_failed', orderId: order.id, err });
  }
}
