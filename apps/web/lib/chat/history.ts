import type { AgentMessage } from '@oplati/agent';
import type { MessageHistoryItem } from '@oplati/db';

/**
 * История диалога из БД → формат Anthropic messages для `runAgent`.
 *
 * Зеркалит логику Telegram-стороны (lib/telegram/handle-update.ts):
 *   - `operator` мапится на `assistant` (для AI оператор = «от имени сервиса»);
 *   - `system` отбрасывается;
 *   - схлопываем consecutive same-role (Anthropic ругается на повтор ролей);
 *   - отрезаем ведущие `assistant` (Messages API требует user-first: окно
 *     `loadRecentMessages(…, N)` режет историю по числу строк и при непарной
 *     записи может начаться с assistant — без обрезки каждый ход отвечал бы 400);
 *   - гарантируем, что последнее сообщение — `user` (текущий ввод уже записан
 *     в БД до вызова, но подстраховываемся).
 *
 * Используется ВСЕМИ тремя контурами (веб-чат, продажный бот, помощник
 * поддержки) — не дублировать логику. Различия контуров задаются `opts`:
 *   - `operatorPrefix` — реплики живого оператора помечаются им, чтобы модель
 *     видела, что часть ответов давал человек, и не спорила с ним;
 *   - `mask` — преобразование КАЖДОЙ реплики перед отправкой провайдеру.
 *     Маскировать снаружи нельзя: история берётся из БД внутри этой функции,
 *     и текущее сообщение прошло бы маску, а вчерашнее с номером карты — нет.
 */
export function toAgentHistory(
  history: MessageHistoryItem[],
  currentUserText: string,
  opts: { operatorPrefix?: string; mask?: (text: string) => string } = {},
): AgentMessage[] {
  const mask = opts.mask ?? ((t: string) => t);
  const mapped = history
    .filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'operator')
    .map((m) => ({
      role: (m.role === 'operator' ? 'assistant' : m.role) as 'user' | 'assistant',
      content:
        m.role === 'operator' && opts.operatorPrefix
          ? `${opts.operatorPrefix}${mask(m.content)}`
          : mask(m.content),
    }));

  const collapsed: AgentMessage[] = [];
  for (const m of mapped) {
    const prev = collapsed[collapsed.length - 1];
    if (prev && prev.role === m.role) {
      prev.content = `${prev.content}\n\n${m.content}`;
    } else {
      collapsed.push({ ...m });
    }
  }

  // После схлопывания роли чередуются — ведущий assistant максимум один, но
  // while надёжнее к будущим правкам выше по функции.
  while (collapsed[0]?.role === 'assistant') {
    collapsed.shift();
  }

  const last = collapsed[collapsed.length - 1];
  if (!last || last.role !== 'user') {
    collapsed.push({ role: 'user', content: mask(currentUserText) });
  }

  return collapsed;
}
