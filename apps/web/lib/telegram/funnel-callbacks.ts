import 'server-only';

import { InlineKeyboard } from 'grammy';
import { z } from 'zod';

import {
  getDb,
  getOrderById,
  recordClientFeedback,
  setFunnelOptOut,
} from '@oplati/db';
import { expiredSurveyAnswer, startSurveyAnswer } from '@oplati/types';
import type { TelegramCallbackQuery } from '@oplati/types';

import { notifyStaff } from '@/lib/alerts/notify-staff';
import { miniAppUrl } from '@/lib/deployment-url';
import { serverEnv } from '@/lib/env.server';
import { childLogger } from '@/lib/logger';

import { sendSafely } from './send';
import { openSupportEntry } from './support-entry';
import { resolveCallbackContext } from './persist';
import {
  EXPIRED_SURVEY_ANSWER_LABELS,
  FUNNEL_OPTOUT_BUTTON,
  FUNNEL_OPTOUT_DONE_TEXT,
  FUNNEL_PARTNER_BUTTON,
  FUNNEL_THANKS_TEXT,
  RATING_HIGH_TEXT,
  RATING_HIGH_TEXT_NO_LINK,
  RATING_LOW_TEXT,
  RATING_REVIEWS_BUTTON,
  START_SURVEY_ANSWER_LABELS,
  START_SUPPORT_BUTTON,
  buildLowRatingStaffAlert,
} from './templates';

/**
 * Кнопки воронки обратной связи — неймспейс `fb:*` в диспетчере апдейтов
 * (тикеты 03–06 трека retention-funnel):
 *
 *   - `fb:optout`                — «Больше не напоминать» (под каждым сообщением);
 *   - `fb:exp:<key>`             — причина протухшего заказа (msg1);
 *   - `fb:st:<key>`              — ответ «нашёл, что искал?» (msg2);
 *   - `fb:rate:<1..5>:<orderId>` — оценка покупки (msg3) + каскад.
 *
 * Ответы на нажатия — реакция на действие клиента: через привратник не ходят
 * и в бюджет воронки не входят. Rate-limit — общий бакет кнопок в диспетчере,
 * ДО этого модуля.
 */

const log = childLogger('telegram-funnel');

// ─── Клавиатуры сообщений воронки (их собирает джоба) ─────────────────────

const OPTOUT_CALLBACK = 'fb:optout';

/**
 * Опрос: кнопка на каждый ответ (столбиком) + отписка последней строкой.
 * `suffix` — контекст в хвосте callback-data (`fb:<prefix>:<key>:<suffix>`).
 */
function buildSurveyKeyboard(
  prefix: 'exp' | 'st',
  labels: Readonly<Record<string, string>>,
  suffix?: string,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const [key, label] of Object.entries(labels)) {
    keyboard.text(label, `fb:${prefix}:${key}${suffix ? `:${suffix}` : ''}`).row();
  }
  return keyboard.text(FUNNEL_OPTOUT_BUTTON, OPTOUT_CALLBACK);
}

/**
 * msg1: пять причин + отписка. Заказ-триггер едет в callback-data
 * (`fb:exp:<key>:<orderId>`, 53 байта < лимита 64): без него ответ терял бы
 * связку «причина ↔ заказ/сервис» навсегда (ось E full-review; спека держит
 * `client_feedback.order_id` именно для этого).
 */
export function buildExpiredSurveyKeyboard(orderId: string): InlineKeyboard {
  return buildSurveyKeyboard('exp', EXPIRED_SURVEY_ANSWER_LABELS, orderId);
}

/** msg2: четыре ответа + отписка (заказа-триггера по построению нет). */
export function buildStartSurveyKeyboard(): InlineKeyboard {
  return buildSurveyKeyboard('st', START_SURVEY_ANSWER_LABELS);
}

/**
 * msg3: одна строка звёзд 1–5 + отписка. `orderId` едет в callback-data
 * (`fb:rate:<score>:<uuid>` — 46 байт, лимит Telegram 64): оценка привязана к
 * заказу, а не к «последнему сообщению», и не ломается от двух опросов подряд.
 */
export function buildRatingKeyboard(orderId: string): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (let score = 1; score <= 5; score++) {
    keyboard.text(`${score} ⭐`, `fb:rate:${score}:${orderId}`);
  }
  return keyboard.row().text(FUNNEL_OPTOUT_BUTTON, OPTOUT_CALLBACK);
}

/** msg4: web_app-кнопка в Mini App (партнёрский раздел внутри) + отписка. */
export function buildReferralNudgeKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .webApp(FUNNEL_PARTNER_BUTTON, miniAppUrl())
    .row()
    .text(FUNNEL_OPTOUT_BUTTON, OPTOUT_CALLBACK);
}

// ─── Обработчик нажатий ───────────────────────────────────────────────────

/**
 * Точка входа `fb:*` из диспетчера. Callback уже подтверждён и прошёл
 * rate-limit; `parts` — `data.split(':')`.
 *
 * Повторное нажатие не дублирует запись: `recordClientFeedback` отдаёт
 * `false` на конфликте (первый клик побеждает), и повторный клик молчит —
 * каскадные ответы и DM персоналу привязаны к ФАКТУ вставки.
 */
export async function handleFunnelCallback(
  cb: TelegramCallbackQuery,
  chatId: number,
  parts: string[],
  updateId: number,
): Promise<void> {
  const sub = parts[1] ?? '';

  const ctx = await resolveCallbackContext(cb, updateId);
  if (!ctx) return; // БД недоступна — callback подтверждён, деградируем молча.
  const db = getDb();

  switch (sub) {
    case 'optout': {
      await setFunnelOptOut(db, ctx.userId);
      await sendSafely(chatId, FUNNEL_OPTOUT_DONE_TEXT, updateId);
      return;
    }
    case 'exp':
    case 'st': {
      const kind = sub === 'exp' ? ('expired_survey' as const) : ('start_survey' as const);
      const schema = sub === 'exp' ? expiredSurveyAnswer : startSurveyAnswer;
      const parsed = schema.safeParse(parts[2]);
      if (!parsed.success) break;
      // Заказ-триггер msg1 — best-effort контекст: битый/чужой uuid НЕ
      // отбрасывает ответ (ответ — про клиента), а просто пишется без связки.
      let orderId: string | null = null;
      if (sub === 'exp') {
        const parsedOrder = z.string().uuid().safeParse(parts[3]);
        if (parsedOrder.success) {
          const order = await getOrderById(db, parsedOrder.data);
          if (order && order.userId === ctx.userId) orderId = order.id;
        }
      }
      const inserted = await recordClientFeedback(db, {
        userId: ctx.userId,
        kind,
        orderId,
        answer: parsed.data,
      });
      log.info({ event: 'funnel.feedback.answer', kind, answer: parsed.data, inserted, updateId });
      // «Другое» — та же дверь в поддержку, что кнопка «Поддержка» (правило
      // В3: обращение создаётся только кнопкой). И при повторном нажатии тоже:
      // ответ уже записан, но клиент явно хочет в поддержку.
      if (parsed.data === 'other') {
        await openSupportEntry(cb, chatId, updateId);
        return;
      }
      if (inserted) {
        await sendSafely(chatId, FUNNEL_THANKS_TEXT, updateId);
      }
      return;
    }
    case 'rate': {
      const score = Number.parseInt(parts[2] ?? '', 10);
      // UUID-валидация на границе (инвариант 5): callback-data подделывается,
      // и мусор вместо uuid ронял бы запрос к БД «invalid input syntax» в
      // Sentry на каждый клик — это ожидаемый вход, а не авария.
      const orderIdParsed = z.string().uuid().safeParse(parts[3]);
      if (!Number.isInteger(score) || score < 1 || score > 5 || !orderIdParsed.success) break;
      const orderId = orderIdParsed.data;
      // Callback-data приходит от клиента и подделывается: заказ обязан
      // принадлежать нажавшему И быть завершённым — оценка спрашивается
      // только по completed, а форж по своему черновику/expired писал бы
      // мусор в client_feedback и дёргал DM персоналу (оси B и C
      // full-review). Сбой БД здесь НЕ глотаем — он уедет в catch роута
      // бота (лог + Sentry + 200), а клик просто останется без ответа.
      const order = await getOrderById(db, orderId);
      if (!order || order.userId !== ctx.userId || order.status !== 'completed') {
        log.warn({ event: 'funnel.rating.invalid_order', updateId, orderId });
        return;
      }
      const inserted = await recordClientFeedback(db, {
        userId: ctx.userId,
        kind: 'order_rating',
        orderId,
        score,
      });
      log.info({ event: 'funnel.feedback.rating', score, orderId, inserted, updateId });
      // Первый клик победил раньше — молчим: каскад и DM уже отработали.
      if (!inserted) return;

      if (score >= 4) {
        const reviewsUrl = serverEnv.REVIEWS_CHAT_URL;
        if (reviewsUrl) {
          await sendSafely(
            chatId,
            RATING_HIGH_TEXT,
            updateId,
            new InlineKeyboard().url(RATING_REVIEWS_BUTTON, reviewsUrl),
          );
        } else {
          await sendSafely(chatId, RATING_HIGH_TEXT_NO_LINK, updateId);
        }
        return;
      }

      // 1–3: клиенту — дверь в поддержку ПЕРВОЙ, потом сигнал персоналу
      // (приоритет доставки клиенту — прецедент антифрод-трека).
      await sendSafely(
        chatId,
        RATING_LOW_TEXT,
        updateId,
        new InlineKeyboard().text(START_SUPPORT_BUTTON, 'support'),
      );
      await notifyStaff(buildLowRatingStaffAlert({ score, shortId: order.shortId }), {
        capability: 'support',
        // DM и так уходит ровно один (гейт — факт вставки оценки); окно —
        // страховка от неожиданных повторов, не основной механизм.
        dedupKey: `funnel-rating-${orderId}`,
      });
      return;
    }
    default:
      break;
  }
  log.warn({ event: 'funnel.callback.invalid', updateId, data: parts.join(':') });
}
