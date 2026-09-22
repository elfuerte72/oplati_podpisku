import { smmConfig, type SmmConfig } from '../config/smm.config.ts';
import { TEXTS } from '../dialog/texts.ts';
import { threadsPieces } from '../lint/threads.ts';
import { threadsIntentUrl } from './intent.ts';

/**
 * Передача поста Threads человеку. Автопостинга нет (решение владельца
 * 15.09.2026): у площадки нет ни разметки, ни кнопок, ни публикации без App
 * Review, поэтому бот готовит текст и отдаёт владельцу кнопку Web Intent.
 *
 * Порядок сообщений подобран под человека с телефоном (жалоба владельца
 * 16.09.2026 на первую версию): сначала САМ ПОСТ и кнопка, которая открывает
 * приложение с этим текстом; картинка после текста с одной фразой, что с ней
 * делать; части цепочки — только если они есть, с одним объяснением на всех.
 */

export interface HandoffButton {
  readonly text: string;
  readonly url?: string;
  /** Текст, который кнопка кладёт в буфер: запасной путь, если адрес не влез. */
  readonly copyText?: string;
}

export interface HandoffMessage {
  readonly kind: 'text' | 'photo';
  readonly text: string;
  /** Текст размечен HTML (блок `<pre>` для копирования частей цепочки). */
  readonly html?: boolean;
  readonly button?: HandoffButton;
  readonly photoPath?: string;
}

export interface ThreadsHandoffInput {
  readonly body: string;
  readonly tag?: string;
  readonly imagePath?: string;
  /** Оценка редактора: если он против, это говорит КОД, а не модель. */
  readonly judgeNote?: string;
  readonly config?: SmmConfig;
}

export function threadsHandoff(input: ThreadsHandoffInput): HandoffMessage[] {
  const config = input.config ?? smmConfig;
  const pieces = threadsPieces(input.body, config.threads.separator);
  const first = pieces[0] ?? '';
  const messages: HandoffMessage[] = [];

  const head = ['Пост для Threads'];
  if (pieces.length > 1) head.push(`цепочка из ${pieces.length} частей, ниже первая`);
  if (input.judgeNote !== undefined && input.judgeNote !== '') head.push(input.judgeNote);

  const intent = threadsIntentUrl(first, input.tag, config);
  const fits = intent.length <= config.threads.intentUrlMax;
  messages.push({
    kind: 'text',
    text: `${head.join('\n')}\n\n${first}`,
    button: fits
      ? { text: TEXTS.buttons.openThreads, url: intent }
      : // Адрес не влез (кириллица в percent-encoding это шесть знаков на
        // букву) — даём кнопку копирования, а не битую ссылку.
        { text: TEXTS.buttons.copyText, copyText: first },
  });

  if (input.imagePath !== undefined) {
    messages.push({
      kind: 'photo',
      photoPath: input.imagePath,
      text: 'Картинка к этому посту. Кнопка её не передаёт: сохрани и приложи в Threads сама.',
    });
  }

  if (pieces.length > 1) {
    messages.push({
      kind: 'text',
      text:
        'Остальные части идут ответами к твоему посту: выложи пост кнопкой выше, открой его в Threads, ' +
        'нажми «Ответить» и вставь части по очереди. Касание по блоку копирует его целиком.',
    });
    pieces.slice(1).forEach((piece, index) => {
      messages.push({
        kind: 'text',
        html: true,
        text: `Часть ${index + 2} из ${pieces.length}\n<pre>${escapeHtml(piece)}</pre>`,
      });
    });
  }

  return messages;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
