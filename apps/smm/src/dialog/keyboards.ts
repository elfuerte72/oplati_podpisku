import { RUBRIC_KEYS, smmConfig, type RubricKey, type SmmConfig } from '../config/smm.config.ts';
import { buildCallback } from './callback.ts';
import { TEXTS } from './texts.ts';
import {
  PICK_LIMITS,
  type AngleOption,
  type Keyboard,
  type KeyboardButton,
  type SourceCandidate,
} from './types.ts';

/** Клавиатуры — функции от состояния: один вопрос, один набор кнопок. */

/**
 * Ряд кнопок-номеров к вопросу с вариантами. Сами варианты целиком стоят в
 * тексте сообщения (`TEXTS.askSourcePick`, `TEXTS.askAngle`): подпись в
 * кнопке Telegram на телефоне обрезается, и выбирать приходилось по обрывку.
 */
function numberRow(count: number, action: (index: number) => string, postId: string, stamp: string): KeyboardButton[][] {
  if (count <= 0) return [];
  return [
    Array.from({ length: count }, (_, index) => ({
      text: String(index + 1),
      data: buildCallback(action(index), postId, stamp),
    })),
  ];
}

export function sourcePickKeyboard(
  postId: string,
  stamp: string,
  candidates: readonly SourceCandidate[],
): Keyboard {
  const count = Math.min(candidates.length, PICK_LIMITS.sources);
  return {
    rows: [
      ...numberRow(count, (index) => `pick.${index}`, postId, stamp),
      [{ text: TEXTS.buttons.cancel, data: buildCallback('drop', postId, stamp) }],
    ],
  };
}

export function rubricKeyboard(
  postId: string,
  stamp: string,
  proposed: RubricKey,
  config: SmmConfig = smmConfig,
): Keyboard {
  // Предложенная рубрика идёт первой и помечена: владелец чаще соглашается,
  // и лишний поиск глазами тут ни к чему.
  const order: RubricKey[] = [proposed, ...RUBRIC_KEYS.filter((key) => key !== proposed)];
  return {
    rows: order.map((key) => [
      {
        text: key === proposed ? `✓ ${config.rubrics[key].title}` : config.rubrics[key].title,
        data: buildCallback(`rub.${key}`, postId, stamp),
      },
    ]),
  };
}

export function angleKeyboard(
  postId: string,
  stamp: string,
  angles: readonly AngleOption[],
  canAskMore: boolean,
): Keyboard {
  const count = Math.min(angles.length, PICK_LIMITS.angles);
  const rows = numberRow(count, (index) => `ang.${index}`, postId, stamp);
  if (canAskMore) {
    rows.push([{ text: TEXTS.buttons.moreAngles, data: buildCallback('more', postId, stamp) }]);
  }
  return { rows };
}

export function previewKeyboard(postId: string, stamp: string): Keyboard {
  return {
    rows: [
      [
        { text: TEXTS.buttons.publish, data: buildCallback('pub', postId, stamp) },
        { text: TEXTS.buttons.edit, data: buildCallback('edit', postId, stamp) },
      ],
      [
        { text: TEXTS.buttons.otherAngle, data: buildCallback('angle', postId, stamp) },
        { text: TEXTS.buttons.drop, data: buildCallback('drop', postId, stamp) },
      ],
    ],
  };
}

export function editChoiceKeyboard(postId: string, stamp: string): Keyboard {
  return {
    rows: [
      [{ text: TEXTS.buttons.sayWhat, data: buildCallback('edit.say', postId, stamp) }],
      [{ text: TEXTS.buttons.ownText, data: buildCallback('edit.own', postId, stamp) }],
      [{ text: TEXTS.buttons.back, data: buildCallback('back', postId, stamp) }],
    ],
  };
}

export function publishPendingKeyboard(postId: string, stamp: string): Keyboard {
  return { rows: [[{ text: TEXTS.buttons.cancel, data: buildCallback('cancel', postId, stamp) }]] };
}

/**
 * Превью Threads: публикует ЧЕЛОВЕК, поэтому первой кнопкой идёт ссылка
 * Web Intent, а «Выложил» только фиксирует факт.
 */
export function threadsPreviewKeyboard(
  postId: string,
  stamp: string,
  // ⚠️ Кнопку строит ОДНО место — сборка передачи (`threads/handoff.ts`):
  // адрес Web Intent обязан совпадать с тем, по которому линт проверял длину.
  open?: KeyboardButton,
): Keyboard {
  return {
    rows: [
      ...(open === undefined ? [] : [[open]]),
      [{ text: TEXTS.buttons.posted, data: buildCallback('posted', postId, stamp) }],
      [
        { text: TEXTS.buttons.edit, data: buildCallback('edit', postId, stamp) },
        { text: TEXTS.buttons.otherAngle, data: buildCallback('angle', postId, stamp) },
      ],
      [{ text: TEXTS.buttons.drop, data: buildCallback('drop', postId, stamp) }],
    ],
  };
}

/**
 * Под опубликованным постом канала: та же тема на площадке пишется по ТОМУ ЖЕ
 * досье, и предложить это стоит сразу, пока владелец здесь.
 */
export function publishedKeyboard(postId: string, stamp: string): Keyboard {
  return { rows: [[{ text: TEXTS.buttons.threadsVersion, data: buildCallback('thr', postId, stamp) }]] };
}

export function failedKeyboard(postId: string, stamp: string, hasText = true): Keyboard {
  return {
    rows: [
      // Шаг мог упасть ДО того, как появился текст: тогда «Показать как есть»
      // показал бы пустоту и увёл бы в превью без тела.
      ...(hasText ? [[{ text: TEXTS.buttons.showAsIs, data: buildCallback('show', postId, stamp) }]] : []),
      [{ text: TEXTS.buttons.drop, data: buildCallback('drop', postId, stamp) }],
    ],
  };
}
