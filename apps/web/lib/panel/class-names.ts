import type { ConversationMode } from '@oplati/types';

import type { PanelStatusTone } from './format';

/**
 * Имена классов панели, которые раньше собирались подстановкой прямо в
 * разметке (`panel-status--${tone}`).
 *
 * Зачем закрытый словарь: имя, склеенное в шаблонной строке, невидимо для
 * канарейки `app/admin/panel-css.test.ts` — она сверяет СТРОКИ разметки с
 * описанными в стилях классами, а `${tone}` строкой не является. Именно так
 * три режима поддержки полтора месяца рисовались одной серой пилюлей: класса
 * `panel-status--mode-ai` в стилях не было, и никто об этом не узнал.
 *
 * ⚠️ Модуль едет в клиентский бандл вместе с `format.ts`: импорты только
 * `type`, ни Next, ни env, ни БД.
 */

/**
 * Пилюля статуса по тону строки. Возвращается ПОЛНАЯ пара классов: базовый
 * `panel-status` носит форму и кегль, модификатор — цвет.
 */
export const STATUS_TONE_CLASS = {
  danger: 'panel-status panel-status--danger',
  warn: 'panel-status panel-status--warn',
  ok: 'panel-status panel-status--ok',
  muted: 'panel-status panel-status--muted',
} as const satisfies Record<PanelStatusTone, string>;

/**
 * Режим разговора поддержки — кто сейчас отвечает клиенту. Типизировано по
 * enum'у: новое значение обязано сломать сборку, а не покрасить пилюлю мимо.
 */
const SUPPORT_MODE_CLASS = {
  idle: 'panel-status panel-status--mode-idle',
  ai: 'panel-status panel-status--mode-ai',
  operator: 'panel-status panel-status--mode-operator',
} as const satisfies Record<ConversationMode, string>;

/**
 * Пилюля режима. Значение приходит из базы: незнакомое показывается как есть
 * (это сигнал разъезда, а не повод ронять экран) — и красится нейтрально.
 */
export function supportModeClass(mode: string): string {
  return Object.hasOwn(SUPPORT_MODE_CLASS, mode)
    ? (SUPPORT_MODE_CLASS[mode as ConversationMode] ?? STATUS_TONE_CLASS.muted)
    : STATUS_TONE_CLASS.muted;
}

/**
 * Строка отклика формы. Вид определяет только цвет; классы перечислены здесь,
 * а не склеены из `panel-note--${kind}`, — канарейка стилей ловит именно такие
 * склейки, и на этом же компоненте она сработала при его написании.
 */
export const NOTE_KIND_CLASS = {
  ok: 'panel-note panel-note--ok',
  warn: 'panel-note panel-note--warn',
  error: 'panel-note panel-note--error',
} as const;

export type PanelNoteKind = keyof typeof NOTE_KIND_CLASS;

const THREAD_ROLE_CLASS: Record<string, string> = {
  user: 'panel-thread__item panel-thread__item--user',
  operator: 'panel-thread__item panel-thread__item--operator',
  assistant: 'panel-thread__item panel-thread__item--assistant',
  system: 'panel-thread__item panel-thread__item--system',
};

/**
 * Класс строки в ленте переписки. Роль приходит из базы строкой, и значение,
 * которого в словаре ещё нет, не должно ронять экран: реплика рисуется
 * нейтрально — так же, как её подпись показывается как есть (`support.ts`).
 */
export function threadItemClass(role: string): string {
  return Object.hasOwn(THREAD_ROLE_CLASS, role)
    ? (THREAD_ROLE_CLASS[role] ?? 'panel-thread__item')
    : 'panel-thread__item';
}
