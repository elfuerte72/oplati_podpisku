import { RUBRIC_KEYS, smmConfig, type RubricKey, type SmmConfig } from '../config/smm.config.ts';
import { buildCallback } from './callback.ts';
import { TEXTS } from './texts.ts';
import type { AngleOption, Keyboard, SourceCandidate } from './types.ts';

/** Клавиатуры — функции от состояния: один вопрос, один набор кнопок. */

export function sourcePickKeyboard(
  postId: string,
  stamp: string,
  candidates: readonly SourceCandidate[],
): Keyboard {
  const rows = candidates.slice(0, 5).map((candidate, index) => [
    {
      // Заголовок обрезается: в кнопке Telegram всё равно помещается немного.
      text: `${index + 1}. ${candidate.title.slice(0, 50)}`,
      data: buildCallback(`pick.${index}`, postId, stamp),
    },
  ]);
  rows.push([{ text: TEXTS.buttons.cancel, data: buildCallback('drop', postId, stamp) }]);
  return { rows };
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
  const rows = angles.slice(0, 3).map((angle, index) => [
    { text: angle.title.slice(0, 60), data: buildCallback(`ang.${index}`, postId, stamp) },
  ]);
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

export function failedKeyboard(postId: string, stamp: string): Keyboard {
  return {
    rows: [
      [{ text: TEXTS.buttons.showAsIs, data: buildCallback('show', postId, stamp) }],
      [{ text: TEXTS.buttons.drop, data: buildCallback('drop', postId, stamp) }],
    ],
  };
}
