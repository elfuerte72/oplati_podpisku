import { z } from 'zod';

/**
 * Воронка обратной связи и удержания (спека `.scratch/retention-funnel/`).
 *
 * Четыре вида исходящих сообщений маскота; литералы обязаны побайтово совпадать
 * со значениями в колонках `funnel_sends.kind` / `client_feedback.kind` И с
 * предикатами частичных уникальных индексов в миграции (текст индекса в БД
 * перечисляет kind'ы строками — БД о zod-енуме не знает).
 */
export const funnelKind = z.enum([
  /** «Что помешало оплатить?» — через 3 часа после протухшего заказа. */
  'expired_survey',
  /** «Нашёл, что искал?» — назавтра после первого визита без заказа. */
  'start_survey',
  /** Оценка 1–5 — через час после выдачи карты. */
  'order_rating',
  /** Персональная реферальная ссылка — через 2 дня после оценки ≥4. */
  'referral_nudge',
]);
export type FunnelKind = z.infer<typeof funnelKind>;

/**
 * Kind'ы, которые уходят клиенту РОВНО один раз за жизнь: их держит частичный
 * UNIQUE(user_id, kind) на `funnel_sends`. `order_rating` в списке нет — он
 * повторяется не чаще раза в 90 дней (правило в привратнике), а его claim
 * атомарен по заказу (частичный UNIQUE(order_id)). Предикат индекса в
 * schema.ts собирается ИЗ ЭТОЙ константы — живого зеркала списка нет
 * (файл применённой миграции — замороженный снимок, не зеркало).
 */
export const FUNNEL_ONCE_PER_USER_KINDS = [
  'expired_survey',
  'start_survey',
  'referral_nudge',
] as const satisfies readonly FunnelKind[];

/**
 * Опросы с кнопками-причинами (msg1/msg2): ответ клиента одноразовый —
 * частичный UNIQUE(user_id, kind) на `client_feedback` собирается из этого
 * списка. Оценки (`order_rating`) здесь нет: её одноразовость — по заказу.
 */
export const FUNNEL_SURVEY_KINDS = [
  'expired_survey',
  'start_survey',
] as const satisfies readonly FunnelKind[];

/** Ключи кнопок-причин опроса протухшего заказа (`fb:exp:<key>`). */
export const expiredSurveyAnswer = z.enum(['price', 'howto', 'changed', 'noservice', 'other']);
export type ExpiredSurveyAnswer = z.infer<typeof expiredSurveyAnswer>;

/** Ключи кнопок опроса «/start без заказа» (`fb:st:<key>`). */
export const startSurveyAnswer = z.enum(['thinking', 'noservice', 'unclear', 'other']);
export type StartSurveyAnswer = z.infer<typeof startSurveyAnswer>;
