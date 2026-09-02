import * as Sentry from '@sentry/nextjs';

import { getDb, listFunnelTextOverrides } from '@oplati/db';
import { expiredSurveyAnswer, startSurveyAnswer } from '@oplati/types';

import { childLogger } from '@/lib/logger';
import { TELEGRAM_BUTTON_LIMIT, TELEGRAM_MESSAGE_LIMIT } from '@/lib/telegram/limits';
import {
  EXPIRED_SURVEY_ANSWER_LABELS,
  EXPIRED_SURVEY_TEXT,
  FUNNEL_OPTOUT_BUTTON,
  FUNNEL_OPTOUT_DONE_TEXT,
  FUNNEL_PARTNER_BUTTON,
  FUNNEL_THANKS_TEXT,
  ORDER_RATING_TEXT,
  ORDER_RATING_TEXT_GENERIC,
  RATING_HIGH_TEXT,
  RATING_HIGH_TEXT_NO_LINK,
  RATING_LOW_TEXT,
  RATING_REVIEWS_BUTTON,
  REFERRAL_NUDGE_TEXT,
  START_SURVEY_ANSWER_LABELS,
  START_SURVEY_TEXT,
} from '@/lib/telegram/templates';

/**
 * Реестр текстов воронки обратной связи (спека admin-panel-v2, ветка C,
 * тикет 10) — ЕДИНСТВЕННАЯ точка чтения клиентских строк воронки.
 *
 * Дефолты — в `templates.ts` (он остаётся источником формулировок маскота),
 * переопределения — в таблице `funnel_texts` (правит владелец из панели),
 * чтение — здесь: `getFunnelTexts()` отдаёт оверлей поверх дефолтов, а
 * `renderFunnelText()` заполняет подстановки. Крон `funnel` и колбэки `fb:*`
 * констант из `templates.ts` не импортируют.
 *
 * Правило домена не меняется: числа, сроки и деньги в БД не живут —
 * редактируются формулировки, подстановки (`{service}`, `{link}`) заполняет код.
 *
 * Чтение с памяткой 60 с в процессе (образец `menu-counts.ts`): слот держит
 * ПРОМИС (параллельные вызовы делят один запрос), неудача не хранится,
 * дедлайн 2 с на вызов. При недоступной БД — дефолты из кода: воронка не
 * должна падать из-за редактора.
 */

const log = childLogger('funnel.texts');

export type FunnelTextGroup = 'expired_survey' | 'start_survey' | 'order_rating' | 'referral_nudge' | 'common';
/**
 * `body` — тело сообщения, `button` — подпись кнопки, `answer` — подпись
 * кнопки-ответа опроса (тоже кнопка, но с правилом уникальности внутри
 * опроса), `reply` — реакция бота на нажатие.
 */
export type FunnelTextKind = 'body' | 'button' | 'answer' | 'reply';

/**
 * Стабильные ключи — они же ключи строк в `funnel_texts`. Не переименовывать:
 * переименование = потеря переопределения владельца. Литеральный список даёт
 * типизированный доступ `texts['…']` без `?? ''`; совпадение с реестром ниже
 * проверяется при загрузке модуля и тестом.
 */
export const FUNNEL_TEXT_KEYS = [
  'expired_survey.body',
  'expired_survey.answer.price',
  'expired_survey.answer.howto',
  'expired_survey.answer.changed',
  'expired_survey.answer.noservice',
  'expired_survey.answer.other',
  'start_survey.body',
  'start_survey.answer.thinking',
  'start_survey.answer.noservice',
  'start_survey.answer.unclear',
  'start_survey.answer.other',
  'order_rating.body',
  'order_rating.body_generic',
  'rating.high',
  'rating.high_no_link',
  'rating.low',
  'rating.reviews_button',
  'referral_nudge.body',
  'referral_nudge.partner_button',
  'common.optout_button',
  'common.optout_done',
  'common.thanks',
] as const;

export type FunnelTextKey = (typeof FUNNEL_TEXT_KEYS)[number];

export type FunnelTextSpec = {
  /** Стабильный ключ — он же ключ строки в `funnel_texts`. Не переименовывать. */
  key: FunnelTextKey;
  group: FunnelTextGroup;
  kind: FunnelTextKind;
  title: string;
  hint: string;
  defaultValue: string;
  placeholders: { required: readonly string[]; optional: readonly string[] };
  maxLength: number;
  /**
   * Экспорты `templates.ts`, из которых взят дефолт, — для канарейки «каждая
   * строка блока воронки зарегистрирована».
   */
  source: readonly string[];
};

/** Подпись кнопки Telegram — лимит Bot API на текст кнопки. */
const BUTTON_MAX = TELEGRAM_BUTTON_LIMIT;

const NO_PLACEHOLDERS = { required: [], optional: [] } as const;

const KEY_SET: ReadonlySet<string> = new Set(FUNNEL_TEXT_KEYS);

function isFunnelTextKey(key: string): key is FunnelTextKey {
  return KEY_SET.has(key);
}

/** Ключ ответа опроса; неизвестный — ошибка программиста, ловится при загрузке модуля. */
function answerKey(group: 'expired_survey' | 'start_survey', answer: string): FunnelTextKey {
  const key = `${group}.answer.${answer}`;
  if (!isFunnelTextKey(key)) throw new Error(`funnel texts: ключ ${key} не объявлен в FUNNEL_TEXT_KEYS`);
  return key;
}

function answerSpecs(
  group: 'expired_survey' | 'start_survey',
  labels: Readonly<Record<string, string>>,
  source: string,
  hint: string,
): FunnelTextSpec[] {
  return Object.entries(labels).map(([answer, label]) => ({
    key: answerKey(group, answer),
    group,
    kind: 'answer',
    title: `Ответ «${answer}»`,
    hint,
    defaultValue: label,
    placeholders: NO_PLACEHOLDERS,
    maxLength: BUTTON_MAX,
    source: [source],
  }));
}

export const FUNNEL_TEXTS: readonly FunnelTextSpec[] = [
  {
    key: 'expired_survey.body',
    group: 'expired_survey',
    kind: 'body',
    title: 'Опрос после протухшего заказа',
    hint: 'Уходит через 3 часа после того, как истёк срок неоплаченного заказа. Под текстом — кнопки-причины.',
    defaultValue: EXPIRED_SURVEY_TEXT,
    placeholders: NO_PLACEHOLDERS,
    maxLength: TELEGRAM_MESSAGE_LIMIT,
    source: ['EXPIRED_SURVEY_TEXT'],
  },
  ...answerSpecs(
    'expired_survey',
    EXPIRED_SURVEY_ANSWER_LABELS,
    'EXPIRED_SURVEY_ANSWER_LABELS',
    'Подпись кнопки-причины. Подписи внутри опроса не должны повторяться.',
  ),
  {
    key: 'start_survey.body',
    group: 'start_survey',
    kind: 'body',
    title: 'Опрос «нашёл, что искал?»',
    hint: 'Уходит через сутки после /start, если заказа так и не было.',
    defaultValue: START_SURVEY_TEXT,
    placeholders: NO_PLACEHOLDERS,
    maxLength: TELEGRAM_MESSAGE_LIMIT,
    source: ['START_SURVEY_TEXT'],
  },
  ...answerSpecs(
    'start_survey',
    START_SURVEY_ANSWER_LABELS,
    'START_SURVEY_ANSWER_LABELS',
    'Подпись кнопки ответа. Подписи внутри опроса не должны повторяться.',
  ),
  {
    key: 'order_rating.body',
    group: 'order_rating',
    kind: 'body',
    title: 'Просьба об оценке',
    hint: 'Уходит через час после выдачи карты. {service} — название сервиса из каталога, обязательно.',
    defaultValue: ORDER_RATING_TEXT,
    placeholders: { required: ['service'], optional: [] },
    maxLength: TELEGRAM_MESSAGE_LIMIT,
    source: ['ORDER_RATING_TEXT'],
  },
  {
    key: 'order_rating.body_generic',
    group: 'order_rating',
    kind: 'body',
    title: 'Просьба об оценке — заказ вне каталога',
    hint: 'Тот же момент, но сервис назван не по каталогу: подстановки нет.',
    defaultValue: ORDER_RATING_TEXT_GENERIC,
    placeholders: NO_PLACEHOLDERS,
    maxLength: TELEGRAM_MESSAGE_LIMIT,
    source: ['ORDER_RATING_TEXT_GENERIC'],
  },
  {
    key: 'rating.high',
    group: 'order_rating',
    kind: 'reply',
    title: 'Ответ на оценку 4–5 (чат отзывов настроен)',
    hint: 'Ссылка на чат отзывов идёт кнопкой, в текст её подставлять не нужно.',
    defaultValue: RATING_HIGH_TEXT,
    placeholders: NO_PLACEHOLDERS,
    maxLength: TELEGRAM_MESSAGE_LIMIT,
    source: ['RATING_HIGH_TEXT'],
  },
  {
    key: 'rating.high_no_link',
    group: 'order_rating',
    kind: 'reply',
    title: 'Ответ на оценку 4–5 (чата отзывов нет)',
    hint: 'Уходит, когда адрес чата отзывов не задан.',
    defaultValue: RATING_HIGH_TEXT_NO_LINK,
    placeholders: NO_PLACEHOLDERS,
    maxLength: TELEGRAM_MESSAGE_LIMIT,
    source: ['RATING_HIGH_TEXT_NO_LINK'],
  },
  {
    key: 'rating.low',
    group: 'order_rating',
    kind: 'reply',
    title: 'Ответ на оценку 1–3',
    hint: 'Под текстом — кнопка «Поддержка»; обращение создаётся только ею.',
    defaultValue: RATING_LOW_TEXT,
    placeholders: NO_PLACEHOLDERS,
    maxLength: TELEGRAM_MESSAGE_LIMIT,
    source: ['RATING_LOW_TEXT'],
  },
  {
    key: 'rating.reviews_button',
    group: 'order_rating',
    kind: 'button',
    title: 'Кнопка чата отзывов',
    hint: 'Под ответом на оценку 4–5.',
    defaultValue: RATING_REVIEWS_BUTTON,
    placeholders: NO_PLACEHOLDERS,
    maxLength: BUTTON_MAX,
    source: ['RATING_REVIEWS_BUTTON'],
  },
  {
    key: 'referral_nudge.body',
    group: 'referral_nudge',
    kind: 'body',
    title: 'Реферальное касание',
    hint: 'Уходит через 2 дня после оценки 4–5. {link} — персональная ссылка партнёра, обязательно. Ставку цифрой не называть.',
    defaultValue: REFERRAL_NUDGE_TEXT,
    placeholders: { required: ['link'], optional: [] },
    maxLength: TELEGRAM_MESSAGE_LIMIT,
    source: ['REFERRAL_NUDGE_TEXT'],
  },
  {
    key: 'referral_nudge.partner_button',
    group: 'referral_nudge',
    kind: 'button',
    title: 'Кнопка приложения под реферальным касанием',
    hint: 'Открывает Mini App, партнёрский раздел внутри.',
    defaultValue: FUNNEL_PARTNER_BUTTON,
    placeholders: NO_PLACEHOLDERS,
    maxLength: BUTTON_MAX,
    source: ['FUNNEL_PARTNER_BUTTON'],
  },
  {
    key: 'common.optout_button',
    group: 'common',
    kind: 'button',
    title: 'Кнопка отписки',
    hint: 'Стоит под каждым сообщением воронки.',
    defaultValue: FUNNEL_OPTOUT_BUTTON,
    placeholders: NO_PLACEHOLDERS,
    maxLength: BUTTON_MAX,
    source: ['FUNNEL_OPTOUT_BUTTON'],
  },
  {
    key: 'common.optout_done',
    group: 'common',
    kind: 'reply',
    title: 'Ответ на отписку',
    hint: 'После нажатия «Больше не напоминать».',
    defaultValue: FUNNEL_OPTOUT_DONE_TEXT,
    placeholders: NO_PLACEHOLDERS,
    maxLength: TELEGRAM_MESSAGE_LIMIT,
    source: ['FUNNEL_OPTOUT_DONE_TEXT'],
  },
  {
    key: 'common.thanks',
    group: 'common',
    kind: 'reply',
    title: 'Благодарность за ответ на опрос',
    hint: 'После любой кнопки-причины, кроме «Другое» (оно ведёт в поддержку).',
    defaultValue: FUNNEL_THANKS_TEXT,
    placeholders: NO_PLACEHOLDERS,
    maxLength: TELEGRAM_MESSAGE_LIMIT,
    source: ['FUNNEL_THANKS_TEXT'],
  },
];

const SPEC_BY_KEY = new Map<string, FunnelTextSpec>(FUNNEL_TEXTS.map((s) => [s.key, s]));

// Реестр и список ключей — одно множество: расхождение ловится при загрузке
// модуля (и тестом), а не первым обращением к несуществующему ключу.
if (SPEC_BY_KEY.size !== FUNNEL_TEXT_KEYS.length || FUNNEL_TEXT_KEYS.some((k) => !SPEC_BY_KEY.has(k))) {
  throw new Error('funnel texts: FUNNEL_TEXT_KEYS и FUNNEL_TEXTS разошлись');
}

export function funnelTextSpec(key: string): FunnelTextSpec | undefined {
  return SPEC_BY_KEY.get(key);
}

/** Ключи ответов опроса — enum'ы `@oplati/types`; ключ реестра собирается из них. */
export function surveyAnswerKey(group: 'expired_survey' | 'start_survey', answer: string): FunnelTextKey {
  const schema = group === 'expired_survey' ? expiredSurveyAnswer : startSurveyAnswer;
  return answerKey(group, schema.parse(answer));
}

/** Все тексты воронки: по каждому ключу — строка (оверлей поверх дефолта). */
export type FunnelTextValues = Readonly<Record<FunnelTextKey, string>>;

// ─── Рендер и валидация ───────────────────────────────────────────────────

const PLACEHOLDER_RE = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

/**
 * Подстановка `{name}`. Неизвестная подстановка — ошибка, а не пустота: это
 * защита на чтении на случай, если валидацию при сохранении обошли (правка БД
 * руками), и клиент не должен получить сообщение с дырой.
 */
export function renderFunnelText(template: string, params: Record<string, string>): string {
  return template.replace(PLACEHOLDER_RE, (_, name: string) => {
    const value = params[name];
    if (value === undefined) {
      throw new Error(`renderFunnelText: неизвестная подстановка {${name}}`);
    }
    return value;
  });
}

/**
 * Запас на подстановку в символах: длина проверяется по ОТРЕНДЕРЕННОМУ тексту,
 * а он длиннее шаблона. Иначе шаблон на 4090 символов с `{service}` проходил бы
 * сохранение и тест-отправку (там подставляется короткое «Netflix»), а живое
 * касание получало бы 400 «message is too long» от Telegram — УЖЕ после
 * занятого claim'а, то есть касание терялось бы навсегда (code-review
 * 2026-09-02). Запас берётся по самому длинному правдоподобному значению:
 * название сервиса каталога и deep-link с реферальным кодом.
 */
const PLACEHOLDER_RESERVE: Readonly<Record<string, number>> = { service: 96, link: 128 };
const PLACEHOLDER_RESERVE_DEFAULT = 96;

export type FunnelTextValidation =
  | { ok: true; value: string }
  | { ok: false; reason: 'empty' }
  | { ok: false; reason: 'missing_placeholder'; placeholder: string }
  | { ok: false; reason: 'unknown_placeholder'; placeholder: string }
  | { ok: false; reason: 'too_long'; max: number }
  | { ok: false; reason: 'duplicate_label' };

/**
 * Проверка САМОЙ строки, без оглядки на соседей: непустая после trim; все
 * обязательные подстановки на месте; неизвестных `{…}` нет; длина в лимите с
 * запасом на подстановки.
 *
 * Отделена от `validateFunnelText`, потому что её зовёт ещё и чтение оверлея
 * из БД (`loadOverrides`): там нужно понять, годится ли строка к отправке, а
 * не поссорить её с соседями.
 */
export function validateFunnelTextShape(spec: FunnelTextSpec, raw: string): FunnelTextValidation {
  const value = raw.trim();
  if (value.length === 0) return { ok: false, reason: 'empty' };

  const allowed = new Set([...spec.placeholders.required, ...spec.placeholders.optional]);
  const found = new Set<string>();
  // Длина считается по отрендеренному тексту: сам `{name}` уходит, вместо него
  // приходит значение — берём запас (см. PLACEHOLDER_RESERVE).
  let rendered = value.length;
  for (const m of value.matchAll(PLACEHOLDER_RE)) {
    const name = m[1]!;
    if (!allowed.has(name)) return { ok: false, reason: 'unknown_placeholder', placeholder: name };
    found.add(name);
    rendered += (PLACEHOLDER_RESERVE[name] ?? PLACEHOLDER_RESERVE_DEFAULT) - m[0]!.length;
  }
  if (rendered > spec.maxLength) return { ok: false, reason: 'too_long', max: spec.maxLength };
  for (const required of spec.placeholders.required) {
    if (!found.has(required)) return { ok: false, reason: 'missing_placeholder', placeholder: required };
  }
  return { ok: true, value };
}

/**
 * Одна проверка на сохранение и на тест-отправку: всё из
 * `validateFunnelTextShape` плюс уникальность подписей ответов внутри одного
 * опроса — с учётом переопределений соседей (`siblings`: ключ → текущее
 * значение).
 */
export function validateFunnelText(
  spec: FunnelTextSpec,
  raw: string,
  siblings: Readonly<Record<string, string>> = {},
): FunnelTextValidation {
  const shape = validateFunnelTextShape(spec, raw);
  if (!shape.ok) return shape;
  const value = shape.value;

  if (spec.kind === 'answer') {
    const others = FUNNEL_TEXTS.filter((s) => s.group === spec.group && s.kind === 'answer' && s.key !== spec.key);
    for (const other of others) {
      const current = siblings[other.key] ?? other.defaultValue;
      if (current.trim() === value) return { ok: false, reason: 'duplicate_label' };
    }
  }

  return { ok: true, value };
}

// ─── Чтение с памяткой ────────────────────────────────────────────────────

const TEXTS_TTL_MS = 60_000;
const TEXTS_DEADLINE_MS = 2_000;
const SENTRY_WINDOW_MS = 10 * 60_000;

type Slot = { work: Promise<Record<string, string> | null>; at: number; done: boolean };

let slot: Slot | undefined;
/** Окно Sentry для отказа ЗАГРУЗКИ оверлея. */
let lastReportedAt = 0;
/**
 * Окна Sentry для негодных строк — СВОЁ на ключ, отдельно от окна отказа
 * загрузки: одно общее означало бы, что одна испорченная строка десять минут
 * глушит алёрт о недоступной базе (и наоборот), а испорченных строк может быть
 * несколько сразу — сообщить надо о каждой.
 */
const invalidReportedAt = new Map<string, number>();

function defaults(): Record<FunnelTextKey, string> {
  const out = {} as Record<FunnelTextKey, string>;
  for (const spec of FUNNEL_TEXTS) out[spec.key] = spec.defaultValue;
  return out;
}

/** Сброс памятки — после сохранения/сброса текста в том же процессе. */
export function invalidateFunnelTexts(): void {
  slot = undefined;
  // Строку только что правили: если она снова окажется негодной, об этом надо
  // узнать сразу, а не через окно дедупа.
  invalidReportedAt.clear();
}

async function loadOverrides(now: number): Promise<Record<string, string> | null> {
  try {
    const rows = await listFunnelTextOverrides(getDb());
    const out: Record<string, string> = {};
    for (const row of rows) {
      // Ключ, которого в реестре нет (переименовали/удалили), — молча мимо:
      // ронять воронку из-за строки в БД нельзя.
      if (!isFunnelTextKey(row.key)) continue;
      const spec = SPEC_BY_KEY.get(row.key);
      if (!spec) continue;
      // Строка из БД проверяется ЗДЕСЬ, на единственном чтении, а не только на
      // сохранении: правка через psql, восстановление из бэкапа или
      // переименование подстановки в коде оставляют в таблице текст, на
      // котором `renderFunnelText` бросает — а бросает он уже ПОСЛЕ занятого
      // claim'а (касание теряется навсегда) или посреди фазы крона (остальные
      // клиенты пропускаются). Негодная строка откатывается на дефолт и
      // проговаривается вслух (code-review 2026-09-02).
      const checked = validateFunnelTextShape(spec, row.value);
      if (!checked.ok) {
        log.error({ event: 'funnel.texts.invalid_override', key: row.key, reason: checked.reason });
        if (now - (invalidReportedAt.get(row.key) ?? 0) >= SENTRY_WINDOW_MS) {
          invalidReportedAt.set(row.key, now);
          Sentry.captureException(
            new Error(`funnel text override is invalid: ${row.key} (${checked.reason})`),
            { tags: { source: 'funnel.texts' } },
          );
        }
        continue;
      }
      out[row.key] = checked.value;
    }
    return out;
  } catch (err) {
    log.error({ event: 'funnel.texts.load_failed', err });
    if (now - lastReportedAt >= SENTRY_WINDOW_MS) {
      lastReportedAt = now;
      Sentry.captureException(err, { tags: { source: 'funnel.texts' } });
    }
    return null;
  }
}

/**
 * Все тексты воронки: оверлей из БД поверх дефолтов. Никогда не бросает и
 * никогда не ждёт дольше дедлайна — при отказе или таймауте отдаёт дефолты.
 *
 * `deadlineMs` — свой для вызывающего. Живому клиенту (колбэк кнопки) важнее
 * ответить хоть чем-то, поэтому там дефолтные 2 секунды. Крону, наоборот,
 * важнее дождаться: он занимает claim и шлёт одноразовое сообщение, и
 * разосланный дефолт означает, что правка владельца до этих клиентов не
 * доедет НИКОГДА (code-review 2026-09-02) — крон ждёт дольше и умеет узнать,
 * что оверлея не было, через `getFunnelTextsDetailed`.
 */
export async function getFunnelTexts(
  now: number = Date.now(),
  deadlineMs: number = TEXTS_DEADLINE_MS,
): Promise<FunnelTextValues> {
  return (await getFunnelTextsDetailed(now, deadlineMs)).texts;
}

/**
 * То же чтение, но видно, читался ли оверлей: `fromOverlay: false` означает
 * «в текстах гарантированно дефолты», и вызывающий вправе не рассылать.
 */
export async function getFunnelTextsDetailed(
  now: number = Date.now(),
  deadlineMs: number = TEXTS_DEADLINE_MS,
): Promise<{ texts: FunnelTextValues; fromOverlay: boolean }> {
  // Незавершённый запрос переиспользуется независимо от срока (см. menu-counts).
  if (!slot || (slot.done && now - slot.at >= TEXTS_TTL_MS)) {
    const work = loadOverrides(now);
    const fresh: Slot = { work, at: now, done: false };
    slot = fresh;
    void work.then((value) => {
      fresh.done = true;
      // Неудача не хранится: следующий вызов спросит снова.
      if (value === null && slot === fresh) slot = undefined;
    });
  }
  const current = slot;

  const overrides = await new Promise<Record<string, string> | null>((resolve) => {
    const timer = setTimeout(() => {
      log.warn({ event: 'funnel.texts.slow', deadlineMs });
      resolve(null);
    }, deadlineMs);
    void current.work.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });

  const merged = defaults();
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (isFunnelTextKey(key)) merged[key] = value;
  }
  return { texts: merged, fromOverlay: overrides !== null };
}
