import 'server-only';

import * as Sentry from '@sentry/nextjs';

import {
  acquireCardFundLock,
  appendOrderEvent,
  findActiveByUserId,
  findOrdersCommittingCardFund,
  getDb,
  insertCardFundReservation,
  releaseCardFundReservation,
  sumLiveCardFundReservations,
  getVccBalanceSnapshot,
  PAYMENT_BLOCKED_CAPACITY_EVENT,
  VCC_SNAPSHOT_PROVIDER,
  type DBLike,
} from '@oplati/db';

import { DedupWindow } from '../alerts/dedup-window.ts';
import { notifyStaff } from '../alerts/notify-staff.ts';
import { serverEnv } from '../env.server.ts';
import { childLogger } from '../logger.ts';
import { currentInvoiceTtlHours } from '../payments/gateway.ts';
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
 * Баланс меняется от НАШИХ выпусков карт (видны в наших же заказах) и от
 * пополнений владельцем (редких, идущих T+1), поэтому снимок почти всегда
 * ошибается «в меньшую сторону»: пополнение он узнаёт с задержкой, а цена
 * ошибки — один лишний отказ, который пройдёт после ближайшего прогона крона.
 *
 * ⚠️ Но НЕ всегда. Есть окно в опасную сторону: карта выпущена, деньги у
 * провайдера уже списаны, заказ ушёл в `completed` и выпал из обязательств — а
 * снимок ещё не переписан. Оно длится до ближайшего прогона крона (5 минут при
 * живом кроне) и завышает свободное на стоимость только что выпущенной карты.
 * Остаточный риск принят: закрыть его значило бы обновлять снимок из
 * `issue-card`, то есть тащить провайдера в путь выпуска ещё раз.
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

/** Окно молчания про перегруженный расчёт — как у отказа: событие срочное. */
const BUSY_ALERT_WINDOW_MS = 15 * 60 * 1000;

const busyDedup = new DedupWindow(BUSY_ALERT_WINDOW_MS);

/**
 * Окно молчания про отсутствующую схему — час: состояние длительное (чинится
 * применением миграции), но забыть о нём нельзя, гейт всё это время не работает.
 */
const SCHEMA_ALERT_WINDOW_MS = 60 * 60 * 1000;

const schemaDedup = new DedupWindow(SCHEMA_ALERT_WINDOW_MS);

/** Только для тестов. */
export function resetPreflightDedupForTests(): void {
  unknownDedup.resetForTests();
  blockedDedup.resetForTests();
  busyDedup.resetForTests();
  schemaDedup.resetForTests();
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
  | {
      state: 'insufficient';
      /** Свободно = остаток фонда − обещанные карты − страховой запас, но не ниже нуля. */
      availableUsdCents: number;
      neededUsdCents: number;
      /** Сколько фонда занято уже обещанными картами. */
      committedUsdCents: number;
      /**
       * Насколько пополнить счёт, чтобы этот заказ прошёл.
       *
       * ⚠️ Считается по НЕклампнутому свободному остатку. Обещанные карты
       * могут превышать то, что лежит на счёте (залипший выпуск, списание уже
       * прошло) — тогда «свободно» показывается нулём, но дыра глубже, и
       * пополнение «на сумму заказа» её не закроет: гейт продолжит отказывать,
       * а владелец будет думать, что уже всё исправил.
       */
      shortfallUsdCents: number;
    }
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
  | { state: 'unknown' }
  /**
   * Занять деньги не удалось: расчёт не смог получить замок фонда за отведённый
   * срок.
   *
   * ⚠️ Здесь fail-CLOSED, в отличие от непрочитанного баланса выше, и это не
   * непоследовательность. Таймаут замка означает очередь из таких же расчётов —
   * то есть РОВНО ту гонку, ради которой замок и поставлен. Пропусти мы оплату,
   * защита выключалась бы сама именно под нагрузкой, и фонд продавался бы
   * дважды. Клиент получает ту же «техническую паузу» и возвращается через
   * десять минут; заказ жив с зафиксированной ценой.
   */
  | { state: 'busy' };

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
  const priceUsdCents = usablePriceUsdCents(order.originalAmount);
  if (priceUsdCents === null) {
    log.warn({ event: 'preflight.no_price', orderId: order.id, price: order.originalAmount });
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

  // «Сколько лежит на счёте» и «сколько свободно» — разные числа. Пока другой
  // клиент держит живой счёт, его карта уже обещана: пропустить по остатку
  // значило бы продать одни и те же деньги дважды.
  // ⚠️ Расчёт и ЗАНЯТИЕ денег — одна неделимая операция (тикет 05). Разделить
  // их нельзя: заказ становится `pending_payment` не в момент прохождения
  // гейта, а ПОСЛЕ создания счёта у шлюза, и внутри этого окна (от полусекунды
  // до пары секунд) двое видят одни и те же свободные деньги.
  //
  // Замок держится только на время подсчёта и снимается на COMMIT — до похода
  // к шлюзу: иначе один зависший чужой вызов выстроил бы в очередь все оплаты.
  try {
    return await claimUnderFundLock(db, order, now, {
      balanceUsdCents: fund.balanceUsdCents,
      neededUsdCents,
      needsNewCard,
    });
  } catch (err) {
    // ⚠️ Развилка по ПРИЧИНЕ, а не «любой сбой одинаково».
    //
    // Нет таблицы (миграцию забыли применить — а применяется она руками, и
    // этот шаг уже терялся) — это НАША авария конфигурации, а не гонка.
    // Трактовать её как «не смогли занять» значило бы превратить гейт в
    // стоп-кран: 422 всем клиентам во всех пяти каналах разом. Работаем как до
    // трека: оплату пропускаем, владельцу говорим прямо про миграцию.
    if (isMissingRelationError(err)) {
      await reportFundingSchemaMissing(order, err);
      return { state: 'unknown' };
    }
    // Всё прочее — поводок ожидания замка. См. разбор у ветки `busy`: здесь
    // ОТКАЗЫВАЕМ, потому что таймаут и означает ту самую гонку.
    await reportFundingBusy(order, err);
    return { state: 'busy' };
  }
}

/** Расчёт и занятие фонда — одной транзакцией под общим замком. */
async function claimUnderFundLock(
  db: ReturnType<typeof getDb>,
  order: PreflightOrder,
  now: Date,
  input: { balanceUsdCents: number; neededUsdCents: number; needsNewCard: boolean },
): Promise<FundingCapacityVerdict> {
  const { balanceUsdCents, neededUsdCents, needsNewCard } = input;
  return await db.transaction(async (tx) => {
    await acquireCardFundLock(tx);

    // ⚠️ ПОРЯДОК ЧТЕНИЙ ЗНАЧИМ. Транзакция идёт в READ COMMITTED: у каждого
    // запроса свой снимок, и сосед может уйти `ready_for_payment` →
    // `pending_payment` ровно между ними.
    //
    // Резервы ПЕРВЫМИ: тогда такой сосед попадает в оба чтения (в резервы — по
    // старому статусу, в обязательства — по новому) и считается дважды. Это
    // завышение, то есть безопасная сторона. Обратный порядок терял бы его
    // ЦЕЛИКОМ: из обязательств — потому что статус ещё старый, из резервов —
    // потому что уже новый и join его отсекает. Гейт пропустил бы оплату,
    // которую нечем исполнить, — ровно то, ради чего этот замок и стоит.
    //
    // ⚠️ СВОЙ резерв из подсчёта исключается: повторное нажатие того же
    // клиента иначе вычитало бы собственные деньги и отказывало ему самому.
    const reservedUsdCents = await sumLiveCardFundReservations(tx, now, {
      excludeOrderId: order.id,
    });
    const committedUsdCents = await sumCommittedFunding(tx, now);
    // Сырое значение может быть ОТРИЦАТЕЛЬНЫМ (обещано больше, чем на счёте) —
    // именно по нему считается дефицит; клампом наружу уходит только показ.
    const rawAvailableUsdCents =
      balanceUsdCents -
      committedUsdCents -
      reservedUsdCents -
      serverEnv.PAYSPACE_SAFETY_RESERVE_USD_CENTS;
    const availableUsdCents = Math.max(0, rawAvailableUsdCents);

    if (rawAvailableUsdCents >= neededUsdCents) {
      // Занимаем на срок счёта: не оплатят — освободится само, вместе с
      // платёжным документом, без крона и ручного шага.
      await insertCardFundReservation(tx, {
        orderId: order.id,
        amountUsdCents: neededUsdCents,
        expiresAt: new Date(now.getTime() + currentInvoiceTtlHours() * 60 * 60 * 1000),
      });
      log.info({
        event: 'preflight.claimed',
        orderId: order.id,
        balanceUsdCents,
        committedUsdCents,
        reservedUsdCents,
        availableUsdCents,
        neededUsdCents,
      });
      return { state: 'ok' };
    }

    log.warn({
      event: 'preflight.insufficient',
      orderId: order.id,
      balanceUsdCents,
      committedUsdCents,
      reservedUsdCents,
      availableUsdCents,
      neededUsdCents,
      needsNewCard,
    });
    return {
      state: 'insufficient',
      availableUsdCents,
      neededUsdCents,
      committedUsdCents: committedUsdCents + reservedUsdCents,
      shortfallUsdCents: neededUsdCents - rawAvailableUsdCents,
    };
  });
}

/**
 * Освободить занятые под заказ деньги немедленно — счёт создать не удалось.
 *
 * Никогда не бросает: вызывается уже из обработчика ошибки, и вторая ошибка
 * поверх первой лишила бы клиента внятного ответа. Худший исход отказа —
 * фонд простоит запертым до срока счёта, то есть максимум час.
 */
export async function releaseOrderFundingClaim(orderId: string): Promise<void> {
  try {
    await releaseCardFundReservation(getDb(), orderId);
  } catch (err) {
    // ⚠️ Не только лог: несостоявшееся освобождение запирает карточный фонд до
    // конца срока счёта, а знать об этом по строке в логах никто не будет.
    log.error({ event: 'preflight.release_failed', orderId, err });
    Sentry.captureException(err, {
      tags: { source: 'pay-space.preflight', step: 'release' },
      extra: { orderId },
    });
  }
}

/**
 * Сколько фонда занято картами, которые мы уже пообещали, но не выпустили.
 *
 * ⚠️ Считаем по ХУДШЕМУ случаю — как будто каждому заказу нужна НОВАЯ карта
 * (Р7 спеки). Точный ответ требовал бы join'ить карты клиентов с окном реюза
 * прямо в выборке; завышение стоит $4 на заказ и ошибается в безопасную
 * сторону, а занижение пропустило бы оплату, которую нечем исполнить.
 *
 * Заказы без цены в долларах пропускаем: карту им не выпустят вовсе
 * (`issue-card` завалит их с `invalid_amount`), значит и фонд они не потратят.
 */
/**
 * ⚠️ `payment_review` (холд банка) в обязательства НЕ входит, и это выбор, а не
 * пропуск: холд живёт до 7 дней, и всё это время его сумма морозила бы фонд для
 * живых клиентов. Обратная сторона — заказ, вышедший из холда в `paid`, может
 * потребовать карту, которой уже нет; тогда сработает обычный путь `failed` с
 * ручным разбором, как и до трека.
 */
async function sumCommittedFunding(db: DBLike, now: Date): Promise<number> {
  const awaiting = await findOrdersCommittingCardFund(db, now);
  return awaiting.reduce((sum, o) => {
    const price = usablePriceUsdCents(o.originalAmount);
    if (price === null) return sum;
    return sum + orderFundingRequirementUsdCents({ priceUsdCents: price, needsNewCard: true });
  }, 0);
}

/**
 * Цена заказа, годная для расчёта фонда, — или `null`.
 *
 * `orders.original_amount` nullable, а формула требования на невалидном входе
 * БРОСАЕТ (и правильно делает — это деньги). Одно правило на оба места: и на
 * сам заказ, и на чужие заказы в обязательствах, — иначе они разъедутся при
 * первой же правке порога.
 */
function usablePriceUsdCents(value: number | null): number | null {
  if (value === null || !Number.isInteger(value) || value <= 0) return null;
  return value;
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
  let snapshot: Awaited<ReturnType<typeof getVccBalanceSnapshot>>;
  try {
    snapshot = await getVccBalanceSnapshot(db, VCC_SNAPSHOT_PROVIDER);
  } catch (err) {
    // Таблицы снимка ещё нет (миграцию не применили). Это чтение стоит РАНЬШЕ
    // транзакции занятия, поэтому без своей обработки ошибка улетела бы в общий
    // catch роута — клиент получил бы 500 вместо платёжной ссылки.
    if (!isMissingRelationError(err)) throw err;
    await reportFundingSchemaMissing(order, err);
    return { ok: false, reason: 'unavailable' };
  }
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
 * `42P01 undefined_table` — таблицы ещё нет.
 *
 * Postgres кладёт код в `code`; postgres-js прячет исходную ошибку в `cause`,
 * поэтому смотрим оба уровня. На текст полагаемся только как на последний
 * рубеж — он локализуется настройками сервера.
 */
function isMissingRelationError(err: unknown): boolean {
  const candidates: unknown[] = [err];
  if (typeof err === 'object' && err !== null && 'cause' in err) {
    candidates.push((err as { cause?: unknown }).cause);
  }
  for (const c of candidates) {
    if (typeof c !== 'object' || c === null) continue;
    if ((c as { code?: string }).code === '42P01') return true;
  }
  return err instanceof Error && /does not exist/i.test(err.message);
}

/**
 * Схемы нет: гейт молчит, оплаты идут как до трека, владелец узнаёт причину.
 *
 * Отдельный текст от «касса занята» — иначе сообщение отправляет искать
 * всплеск оплат там, где не хватает одной применённой миграции.
 */
async function reportFundingSchemaMissing(order: PreflightOrder, err: unknown): Promise<void> {
  log.error({ event: 'preflight.schema_missing', orderId: order.id, err });
  if (!schemaDedup.shouldSend('preflight_schema_missing')) return;

  Sentry.captureException(err, {
    tags: { source: 'pay-space.preflight', step: 'schema' },
    extra: { orderId: order.id },
  });
  try {
    await notifyStaff(
      'Проверка карточного фонда ОТКЛЮЧИЛАСЬ: в базе нет её таблиц — похоже, ' +
        'миграции трека vcc-preflight (0039/0040) не применены на этой базе. ' +
        'Оплаты идут как раньше, БЕЗ проверки: заказ снова может упасть после ' +
        'приёма денег.',
      {
        dedupKey: 'preflight_schema_missing_staff',
        dedupWindowMs: SCHEMA_ALERT_WINDOW_MS,
        capability: 'holds',
        title: 'Проверка карточного фонда отключилась',
        action: { text: 'применить миграции и проверить GET /api/ready' },
      },
    );
  } catch (notifyErr) {
    log.error({ event: 'preflight.schema_notify_failed', orderId: order.id, err: notifyErr });
  }
}

/**
 * Занять фонд не удалось. Отдельно от «фонд не прочитан» намеренно: причины
 * разные, и слитый алёрт отправил бы владельца чинить провайдера там, где
 * очередь у нашей же базы, а общее окно дедупа на час глушило бы настоящее
 * «PaySpace недоступен».
 */
async function reportFundingBusy(order: PreflightOrder, err: unknown): Promise<void> {
  log.error({ event: 'preflight.busy', orderId: order.id, err });
  if (!busyDedup.shouldSend('preflight_busy')) return;

  Sentry.captureException(err, {
    tags: { source: 'pay-space.preflight', step: 'claim' },
    extra: { orderId: order.id },
  });
  try {
    await notifyStaff(
      `Не удалось занять карточный фонд под заказ ${order.shortId}: расчёт не дождался ` +
        'своей очереди. Клиенту отказано вежливым текстом, заказ жив. Обычно это всплеск ' +
        'одновременных оплат.',
      {
        dedupKey: 'preflight_busy_staff',
        dedupWindowMs: BUSY_ALERT_WINDOW_MS,
        capability: 'holds',
        // Клиенту отказано — это «Авария», а не отчёт о фонде.
        stream: 'critical',
        title: 'Клиенту отказано: карточный фонд занят',
        action: {
          text: 'при повторах на спокойном трафике — посмотреть длинные транзакции по заказам в базе',
          path: '/admin/pending',
        },
      },
    );
  } catch (notifyErr) {
    log.error({ event: 'preflight.busy_notify_failed', orderId: order.id, err: notifyErr });
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
        'заказ упадёт уже после приёма рублей.',
      {
        title: 'Карточный счёт не прочитан',
        action: { text: 'проверить баланс и доступность PaySpace', path: '/admin' },
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
  const shortfallUsdCents = verdict.shortfallUsdCents;

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
        committedUsdCents: verdict.committedUsdCents,
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
  // ⚠️ Обещанные карты называем ОТДЕЛЬНОЙ строкой. Иначе владелец видит на
  // счёте $200, а в сообщении «доступно $76» — и первым делом идёт проверять
  // баланс руками, решив, что расчёт врёт.
  const committedNote =
    verdict.committedUsdCents > 0
      ? ` (${usdCentsToDollarString(verdict.committedUsdCents)} USD на счёте уже обещаны картам ` +
        'по заказам с живым счётом, оплаченным и в выпуске)'
      : '';

  try {
    await notifyStaff(
      `Клиент не смог оплатить ${order.shortId}${amountRubNote(order)}: ` +
        `свободно ${usdCentsToDollarString(verdict.availableUsdCents)} USD${committedNote}, ` +
        `на этот заказ нужно ${usdCentsToDollarString(verdict.neededUsdCents)} USD — ` +
        `не хватает ${usdCentsToDollarString(shortfallUsdCents)} USD. ` +
        'Счёт клиенту не выставлен, заказ жив с зафиксированной ценой.',
      {
        // ⚠️ Окно ЗАДАЁТСЯ явно: дефолт `notifyStaff` — ЧАС, и без этой строки
        // личка молчала бы вчетверо дольше Sentry, хотя тикет требует ровно
        // обратного — «Sentry под тем же окном».
        dedupKey: 'preflight_blocked_staff',
        dedupWindowMs: BLOCKED_ALERT_WINDOW_MS,
        capability: 'holds',
        // Клиент не смог оплатить — «Авария»: продажа сорвалась прямо сейчас.
        stream: 'critical',
        title: 'Клиент не смог оплатить: не хватает карточного фонда',
        action: { text: 'пополнить карточный счёт PaySpace (зачисление T+1)', path: '/admin' },
      },
    );
  } catch (err) {
    log.error({ event: 'preflight.blocked_notify_failed', orderId: order.id, err });
  }
}
