import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { getDb, updateUserContacts } from '@oplati/db';

import { serverEnv } from '@/lib/env.server';
import { childLogger } from '@/lib/logger';
import { checkRateLimit, getClientIp } from '@/lib/ratelimit';
import { EMAIL_INVALID_TEXT, normalizeEmail } from '@/lib/contacts/email';
import { PHONE_INVALID_TEXT, normalizePhone } from '@/lib/contacts/phone';
import { rememberClientIp } from '@/lib/contacts/track-ip';
import { getBotUsername } from '@/lib/telegram/bot';
import { referralMiniAppShortName } from '@/lib/telegram/deep-links';
import { upsertCabinetUser, verifyCabinetInitData } from '@/lib/cabinet/auth';
import { buildOrderDetail, buildSnapshot } from '@/lib/cabinet/read';
import { getReferralLinkForCabinet } from '@/lib/cabinet/referral-read';
import {
  markSubscriptionActivated,
  payOrder,
  proposeNewOrder,
  reportPaymentIssue,
  reportPaymentProblem,
} from '@/lib/cabinet/actions';
import { PAYMENT_ISSUE_TYPES, PAYMENT_PROBLEM_TYPES } from '@/lib/cabinet/payment-issues';
import { getCardSecretsForUser } from '@/lib/cabinet/card-secrets';

/**
 * POST /api/cabinet — бэкенд личного кабинета Telegram Mini App.
 *
 * Контракт: тело `{ action, initData, ... }`. `initData` (подпись Telegram)
 * проверяется на КАЖДЫЙ запрос — это единственная авторизация кабинета
 * (см. lib/cabinet/auth.ts). Порядок: разбор тела → проверка подписи (без БД) →
 * rate-limit (по IP для отказов подписи, по telegram_id для опознанных) →
 * upsert пользователя → диспатч действия. Ни один шаг с записью в БД не идёт
 * раньше лимита — инвариант 9.
 *
 * Это НЕ webhook (вызывает наш же клиент), поэтому отвечаем настоящими
 * статус-кодами: 401 — плохая/протухшая подпись, 429 — rate-limit, 404 —
 * чужой/несуществующий заказ, 200 — успех (или ожидаемая ошибка действия в теле).
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const preferredRegion = 'fra1';
export const maxDuration = 60;

const log = childLogger('cabinet-api');

/** Username бота для реф-ссылки — graceful: при сбое ссылка просто опустится (null). */
async function resolveBotUsername(): Promise<string | null> {
  try {
    return await getBotUsername();
  } catch (err) {
    log.warn({ event: 'cabinet.bot_username_failed', err });
    Sentry.captureException(err, { tags: { source: 'cabinet-api', reason: 'bot_username' } });
    return null;
  }
}

const orderAction = z.object({ initData: z.string().min(1), orderId: z.string().uuid() });
const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('snapshot'), initData: z.string().min(1) }),
  orderAction.extend({ action: z.literal('order') }),
  // `email`/`phone` — из плашки контактов (тикеты 02/05): передаются, когда
  // клиент только что ввёл/поменял значение. Формат проверяется в диспатче
  // (normalize*) — Zod-отказ всего тела дал бы invalid_body вместо подсказки.
  orderAction.extend({
    action: z.literal('pay'),
    email: z.string().max(320).optional(),
    phone: z.string().max(32).optional(),
  }),
  // Экран «Профиль» (тикет 08): правка контактов вне заказа. Авторизация
  // initData и per-identity лимит бакета `cabinet` покрывают его как остальные.
  z.object({
    action: z.literal('update-contacts'),
    initData: z.string().min(1),
    email: z.string().max(320).optional(),
    phone: z.string().max(32).optional(),
  }),
  z.object({
    action: z.literal('card-details'),
    initData: z.string().min(1),
    cardId: z.string().uuid(),
  }),
  // Кнопочный каталог Mini App: заказ по slug. Сумма — только для custom-amount
  // сервисов; для тарифных цена берётся сервером из pricing_policy.
  z.object({
    action: z.literal('propose'),
    initData: z.string().min(1),
    slug: z.string().min(1).max(100),
    tierName: z.string().min(1).max(200).optional(),
    tierPeriod: z.enum(['month', 'quarter', 'year']).optional(),
    amountUsdCents: z.number().int().positive().optional(),
  }),
  // «Не проходит оплата?» (ТЗ §6): тип проблемы + опциональный комментарий.
  orderAction.extend({
    action: z.literal('payment-issue'),
    issueType: z.enum(PAYMENT_ISSUE_TYPES),
    comment: z.string().max(1000).optional(),
  }),
  // «Проблема с оплатой» — фаза ДО выпуска карты (антифрод-трек, тикет 10).
  orderAction.extend({
    action: z.literal('payment-problem'),
    problemType: z.enum(PAYMENT_PROBLEM_TYPES),
    comment: z.string().max(1000).optional(),
  }),
  // «Подписка оплачена» — клиент подтвердил успех на сайте сервиса.
  orderAction.extend({ action: z.literal('subscription-paid') }),
]);

const RATE_LIMITED_TEXT = 'Слишком много запросов подряд. Подожди минутку и попробуй снова.';

/**
 * Валидация и сохранение контактов из тела запроса (плашка/профиль, тикеты
 * 02/05/08). Телефон, введённый руками, всегда получает источник 'manual' —
 * telegram-источник ставит ТОЛЬКО contact-сообщение боту (проверенное
 * `contact.user_id === from.id`).
 */
async function saveContactsFromBody(
  userId: string,
  rawEmail: string | undefined,
  rawPhone: string | undefined,
): Promise<{ ok: true } | { ok: false; error: string; message: string }> {
  let email: string | undefined;
  if (rawEmail !== undefined) {
    const normalized = normalizeEmail(rawEmail);
    if (!normalized) return { ok: false, error: 'invalid_email', message: EMAIL_INVALID_TEXT };
    email = normalized;
  }
  let phone: string | undefined;
  if (rawPhone !== undefined) {
    const normalized = normalizePhone(rawPhone);
    if (!normalized) return { ok: false, error: 'invalid_phone', message: PHONE_INVALID_TEXT };
    phone = normalized;
  }
  if (phone !== undefined) {
    await updateUserContacts(getDb(), {
      userId,
      ...(email !== undefined ? { email } : {}),
      phone,
      phoneSource: 'manual',
    });
  } else if (email !== undefined) {
    await updateUserContacts(getDb(), { userId, email });
  }
  return { ok: true };
}

/**
 * 429 в формате, который РАЗБИРАЕТ клиент кабинета: поле `message` заполнено.
 * Схемы действий (`payResultSchema`, `orderCreationResultSchema`) без него
 * раньше не парсились, и Mini App показывал «Сеть недоступна» — то есть звал
 * долбить кнопку ровно там, где надо переждать (ревью 2026-08-11).
 */
function rateLimitedResponse(): NextResponse {
  return NextResponse.json(
    { ok: false, error: 'rate_limited', message: RATE_LIMITED_TEXT },
    { status: 429 },
  );
}

/**
 * Причины отказа подписи, ПОХОЖИЕ на подделку. Только они кормят IP-бакет.
 *
 * `expired` сюда не входит осознанно: протухшая `initData` — штатный конец
 * жизни сессии (TTL 24 ч), у живого клиента это происходит само. Считать её
 * атакой значит подменять понятный текст «открой кабинет заново из бота»
 * бесполезным «подожди минутку» — и делать это сразу всем, кто сидит за общим
 * адресом (CGNAT, наш же VPN). `misconfigured` тоже не входит: это НАША
 * авария конфига (нет `TELEGRAM_BOT_TOKEN`), 500 не должен прятаться за 429.
 */
const FORGED_SIGNATURE_REASONS = new Set([
  'bad_signature',
  'malformed',
  'missing_hash',
  'missing_user',
]);

/**
 * 400 на нераспознанное тело + расход IP-бакета отказов.
 *
 * Наш клиент таких тел не шлёт вовсе, поэтому поток мусора — это чужой скрипт.
 * Без расхода бакета он оставался бы САМЫМ дешёвым способом дёргать роут:
 * разбор тела идёт до проверки подписи, и мимо `cabinet-auth` он проходил
 * целиком (ревью 2026-08-11).
 */
async function badRequest(req: Request, error: 'invalid_json' | 'invalid_body'): Promise<NextResponse> {
  const rl = await checkRateLimit('cabinet-auth', getClientIp(req));
  if (!rl.allowed) {
    log.warn({ event: 'cabinet.auth_flood', reason: error });
    return rateLimitedResponse();
  }
  return NextResponse.json({ ok: false, error }, { status: 400 });
}

export async function POST(req: Request): Promise<NextResponse> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return badRequest(req, 'invalid_json');
  }

  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) {
    return badRequest(req, 'invalid_body');
  }
  const body = parsed.data;

  // 1. Подпись Telegram — ЧИСТАЯ проверка, без единого запроса в БД.
  const verified = verifyCabinetInitData(body.initData);
  if (!verified.ok) {
    // Барьер для НЕаутентифицированного потока (инвариант 9, аудит 2026-08-10):
    // считаем ТОЛЬКО похожие на подделку отказы и только по IP. Успешные
    // запросы бакет не трогают намеренно — на роуте, где каждый запрос
    // криптографически опознан, общий IP-ключ резал бы живых плательщиков за
    // чужой флуд: за CGNAT мобильных операторов и за собственным VPN Оплатишки
    // все сидят под одним адресом. Тот же приём, что у `alert-webhook-auth`.
    if (FORGED_SIGNATURE_REASONS.has(verified.error)) {
      const authRl = await checkRateLimit('cabinet-auth', getClientIp(req));
      if (!authRl.allowed) {
        log.warn({ event: 'cabinet.auth_flood', action: body.action, reason: verified.error });
        return rateLimitedResponse();
      }
    }
    return NextResponse.json({ ok: false, error: verified.error }, { status: verified.status });
  }
  const { telegramId } = verified.identity;

  // 2. Per-identity rate-limit по подтверждённому telegram_id — ДО upsert'а
  //    (аудит 2026-08-10). Раньше он стоял после `resolveCabinetUser`, то есть
  //    держатель одной валидной initData оплачивал записью в `users` и
  //    реферальным захватом каждый свой запрос, сколько бы их ни было. Бакет
  //    свой, не общий с ботом: просмотр кабинета не должен выедать лимит бота.
  const rl = await checkRateLimit('cabinet', telegramId);
  if (!rl.allowed) {
    log.warn({ event: 'cabinet.rate_limited', action: body.action });
    return rateLimitedResponse();
  }

  // 3. Только теперь — запись: upsert `users` + реферальный захват.
  const auth = await upsertCabinetUser(verified.identity);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }
  const { userId } = auth.user;

  // Антифрод-трек (тикет 01): кабинет — самый частый живой запрос клиента,
  // отсюда last_seen_ip обычно и свежий. Троттлинг внутри — листание экранов
  // не генерирует UPDATE на каждый тап.
  await rememberClientIp(req, userId);

  // 4. Диспатч действия.
  try {
    switch (body.action) {
      case 'snapshot': {
        // Реф-ссылка для главного меню (кнопка «Скопировать»). За флагом
        // REFERRAL_ENABLED; при выключенной программе — null (карточку не рисуем).
        // buildSnapshot (тяжёлые DB-запросы) не должен ждать getMe: резолвим
        // bot-username параллельно снапшоту, ссылку собираем следом.
        const referralLinkPromise: Promise<string | null> = serverEnv.REFERRAL_ENABLED
          ? resolveBotUsername().then((botUsername) =>
              getReferralLinkForCabinet(userId, {
                enabled: true,
                botUsername,
                miniAppShortName: referralMiniAppShortName(),
              }),
            )
          : Promise.resolve(null);
        const [snapshot, referralLink] = await Promise.all([
          buildSnapshot(userId),
          referralLinkPromise,
        ]);
        return NextResponse.json({ ok: true, ...snapshot, referralLink }, { status: 200 });
      }
      case 'order': {
        const detail = await buildOrderDetail(userId, body.orderId);
        if (!detail) {
          return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
        }
        return NextResponse.json({ ok: true, order: detail }, { status: 200 });
      }
      case 'pay': {
        // Контакты из плашки сохраняются ДО выставления счёта: гейты
        // email_required/phone_required в payments/create читают профиль.
        const saved = await saveContactsFromBody(userId, body.email, body.phone);
        if (!saved.ok) return NextResponse.json(saved, { status: 200 });
        const result = await payOrder(userId, body.orderId);
        const status = result.ok ? 200 : result.error === 'not_found' ? 404 : 200;
        return NextResponse.json(result, { status });
      }
      case 'update-contacts': {
        // Экран «Профиль»: ручная правка телефона сбрасывает источник в
        // 'manual' (внутри saveContactsFromBody); «Взять из Telegram» идёт
        // МИМО этого action — номер приходит боту contact-сообщением.
        const saved = await saveContactsFromBody(userId, body.email, body.phone);
        return NextResponse.json(saved.ok ? { ok: true } : saved, { status: 200 });
      }
      // Действия `repeat`/`operator` удалены (L-9 аудита, 2026-07-19): кнопки
      // убраны из UI ещё 2026-07-03, repeatOrder был сломан для тарифных
      // (tierName в parameters не пишется), операторов нет.
      case 'propose': {
        const result = await proposeNewOrder(userId, {
          slug: body.slug,
          ...(body.tierName !== undefined ? { tierName: body.tierName } : {}),
          ...(body.tierPeriod !== undefined ? { tierPeriod: body.tierPeriod } : {}),
          ...(body.amountUsdCents !== undefined ? { amountUsdCents: body.amountUsdCents } : {}),
        });
        return NextResponse.json(result, { status: 200 });
      }
      case 'payment-issue': {
        const result = await reportPaymentIssue(
          userId,
          telegramId,
          body.orderId,
          body.issueType,
          body.comment,
        );
        const status = result.ok ? 200 : result.error === 'not_found' ? 404 : 200;
        return NextResponse.json(result, { status });
      }
      case 'payment-problem': {
        const result = await reportPaymentProblem(
          userId,
          telegramId,
          body.orderId,
          body.problemType,
          body.comment,
        );
        const status = result.ok ? 200 : result.error === 'not_found' ? 404 : 200;
        return NextResponse.json(result, { status });
      }
      case 'subscription-paid': {
        const result = await markSubscriptionActivated(userId, body.orderId);
        const status = result.ok ? 200 : result.error === 'not_found' ? 404 : 200;
        return NextResponse.json(result, { status });
      }
      case 'card-details': {
        // Разовый показ реквизитов: live-fetch из PaySpace, в БД не хранятся.
        // no-store — ответ с реквизитами не должен кэшироваться нигде по пути.
        const result = await getCardSecretsForUser(userId, body.cardId);
        const status = result.ok ? 200 : result.error === 'not_found' ? 404 : 200;
        return NextResponse.json(result, { status, headers: { 'cache-control': 'no-store' } });
      }
    }
  } catch (err) {
    log.error({ event: 'cabinet.dispatch.failed', action: body.action, err });
    Sentry.captureException(err, { tags: { source: 'cabinet-api', action: body.action } });
    return NextResponse.json({ ok: false, error: 'internal_error' }, { status: 500 });
  }
}
