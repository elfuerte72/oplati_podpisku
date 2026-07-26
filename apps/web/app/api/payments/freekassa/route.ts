import * as Sentry from '@sentry/nextjs';

import { FREEKASSA_NOTIFICATION_IPS, freekassaNotificationSchema } from '@oplati/types';

import { serverEnv } from '@/lib/env.server';
import { verifyNotificationSignature } from '@/lib/freekassa';
import { processFreekassaPaid } from '@/lib/freekassa/handlers';
import { childLogger } from '@/lib/logger';
import { getClientIp } from '@/lib/ratelimit';

/**
 * POST /api/payments/freekassa — уведомление об оплате (webhook Freekassa).
 *
 * Контракт ответа у этого провайдера ДВОЙНОЙ, и его легко перепутать:
 *
 *  - HTTP-статус всегда `200` (инвариант 6): non-200 у любого шлюза приводит
 *    к ретрай-шторму и забитой очереди;
 *  - принятым уведомление считается по ТЕЛУ `YES`. Поэтому «плохие» исходы
 *    (нет подписи, платёж ещё не найден, неразбираемая сумма, сбой обработчика)
 *    отвечают 200 с телом НЕ `YES` — провайдер повторит, и это ровно то, что
 *    нужно: гонка «уведомление обогнало запись платежа» и «в env было не то
 *    секретное слово» лечатся повтором. `YES` отдаём только когда исход
 *    окончательный: обработали, идемпотентно пропустили или зафиксировали
 *    недоплату.
 *
 * Вебхук работает ВСЕГДА и НЕ гейтится переключателем `PAYMENT_PRIMARY_PROVIDER`:
 * в момент смены провайдера у части клиентов уже выставлены счета Freekassa, и
 * закрытый обработчик означал бы «деньги списаны, заказ не оплачен» (ТЗ, этап 3).
 *
 * ⚠️ `payer_account` (счёт/карта плательщика) не логируется и не сохраняется в
 * сыром виде — только маска (см. `toStorableNotification` в `@oplati/types`).
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const preferredRegion = 'fra1';
export const maxDuration = 30;

const log = childLogger('freekassa-webhook');

/** Уведомление принято и повторять не нужно. */
const accepted = () =>
  new Response('YES', { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });

/**
 * Уведомление НЕ принято: статус всё равно 200 (инвариант 6), но тело не `YES`,
 * поэтому провайдер повторит доставку.
 */
const rejected = (reason: string) =>
  new Response(`NO: ${reason}`, {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });

export async function POST(req: Request): Promise<Response> {
  const params = await readFormParams(req);
  if (!params) {
    log.warn({ event: 'freekassa.webhook.read_body_failed' });
    Sentry.captureMessage('Freekassa webhook: тело не прочитано', {
      level: 'warning',
      tags: { source: 'freekassa.webhook' },
    });
    return rejected('read_failed');
  }

  const secretWord2 = serverEnv.FREEKASSA_SECRET_WORD_2;
  if (!secretWord2) {
    // Не настроено — «принять» нельзя (подпись проверить нечем), но и молча
    // терять деньги тоже: алёртим и просим повторить.
    log.error({ event: 'freekassa.webhook.disabled', missing: 'FREEKASSA_SECRET_WORD_2' });
    Sentry.captureMessage('Freekassa webhook пришёл, но FREEKASSA_SECRET_WORD_2 не задан', {
      level: 'error',
      tags: { source: 'freekassa.webhook' },
    });
    return rejected('not_configured');
  }

  const parsed = freekassaNotificationSchema.safeParse(params);
  if (!parsed.success) {
    log.warn({
      event: 'freekassa.webhook.invalid_payload',
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
    Sentry.captureMessage('Freekassa webhook: payload не прошёл Zod', {
      level: 'warning',
      tags: { source: 'freekassa.webhook' },
    });
    return rejected('invalid_payload');
  }
  const notification = parsed.data;

  // Сверка отправителя. Подпись остаётся единственным ЖЁСТКИМ гейтом: их IP
  // могут смениться молча, и allowlist по умолчанию положил бы приём денег без
  // симптомов, кроме тишины. Плюс за реверс-прокси «правый XFF» — это адрес
  // прокси, а не провайдера, поэтому включать жёсткий режим можно только
  // убедившись по логам, что видимый IP действительно принадлежит Freekassa.
  const senderIp = getClientIp(req);
  const configuredIps = parseAllowedIps(serverEnv.FREEKASSA_ALLOWED_IPS);
  const allowedIps = configuredIps ?? [...FREEKASSA_NOTIFICATION_IPS];
  if (!allowedIps.includes(senderIp)) {
    log.warn({
      event: 'freekassa.webhook.ip_not_allowlisted',
      senderIp,
      enforced: configuredIps !== null,
    });
    Sentry.captureMessage('Freekassa webhook: отправитель вне allowlist', {
      level: configuredIps ? 'error' : 'warning',
      tags: { source: 'freekassa.webhook', alert: 'ip_not_allowlisted' },
      extra: { senderIp, intid: notification.intid, enforced: configuredIps !== null },
    });
    if (configuredIps) return rejected('ip_not_allowed');
  }

  if (!verifyNotificationSignature(notification, secretWord2)) {
    log.warn({ event: 'freekassa.webhook.invalid_signature', intid: notification.intid });
    Sentry.captureMessage('Freekassa webhook: невалидная подпись', {
      level: 'error',
      tags: { source: 'freekassa.webhook' },
      extra: { intid: notification.intid, merchantOrderId: notification.MERCHANT_ORDER_ID },
    });
    return rejected('invalid_signature');
  }

  // Чужой магазин: при верной подписи это невозможно без знания секретного
  // слова, но проверка дешёвая и ловит перепутанный env раньше, чем платёж
  // прилипнет к чужому заказу.
  const shopId = serverEnv.FREEKASSA_SHOP_ID;
  if (shopId !== undefined && notification.MERCHANT_ID !== String(shopId)) {
    log.error({
      event: 'freekassa.webhook.foreign_merchant',
      merchantId: notification.MERCHANT_ID,
    });
    Sentry.captureMessage('Freekassa webhook: MERCHANT_ID не совпал с нашим магазином', {
      level: 'error',
      tags: { source: 'freekassa.webhook' },
      extra: { merchantId: notification.MERCHANT_ID, intid: notification.intid },
    });
    return rejected('foreign_merchant');
  }

  log.info({
    event: 'freekassa.webhook.received',
    intid: notification.intid,
    merchantOrderId: notification.MERCHANT_ORDER_ID,
    amount: notification.AMOUNT,
    curId: notification.CUR_ID,
  });

  try {
    const result = await processFreekassaPaid({ notification });
    // Платёж ещё не записан у нас (гонка с созданием счёта) или сумма
    // неразбираема — просим повторить: во втором случае повтор бессмысленен,
    // но заказ уже заалерчен, а «YES» на непонятную сумму скрыл бы проблему.
    if (result.kind === 'not_found') return rejected('payment_not_found');
    if (result.kind === 'invalid_amount') return rejected('invalid_amount');
    return accepted();
  } catch (err) {
    log.error({ event: 'freekassa.webhook.unexpected_error', intid: notification.intid, err });
    Sentry.captureException(err, {
      tags: { source: 'freekassa.webhook' },
      extra: { intid: notification.intid },
    });
    return rejected('handler_error');
  }
}

/**
 * Разбор тела уведомления. В ЛК зафиксирован POST form-data; принимаем оба
 * представления формы, а если тело пустое — берём query-параметры (некоторые
 * шлюзы шлют POST с данными в URL). JSON провайдер не шлёт.
 */
async function readFormParams(req: Request): Promise<Record<string, string> | null> {
  const contentType = req.headers.get('content-type') ?? '';
  const fromQuery = Object.fromEntries(new URL(req.url).searchParams);

  try {
    if (contentType.includes('multipart/form-data')) {
      const fd = await req.formData();
      const entries: Record<string, string> = {};
      for (const [key, value] of fd.entries()) {
        if (typeof value === 'string') entries[key] = value;
      }
      return { ...fromQuery, ...entries };
    }

    const text = await req.text();
    const body = Object.fromEntries(new URLSearchParams(text));
    return { ...fromQuery, ...body };
  } catch (err) {
    log.error({ event: 'freekassa.webhook.body_parse_failed', err });
    return null;
  }
}

/** `a.b.c.d, e.f.g.h` → список; пустая/незаданная строка → null (режим алёрта). */
function parseAllowedIps(raw: string | undefined): string[] | null {
  if (!raw) return null;
  const list = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : null;
}
