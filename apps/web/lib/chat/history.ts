import type { AgentMessage } from '@oplati/agent';
import type { MessageHistoryItem } from '@oplati/db';

/**
 * История диалога из БД → формат Anthropic messages для `runAgent`.
 *
 * Зеркалит логику Telegram-стороны (lib/telegram/handle-update.ts):
 *   - `operator` мапится на `assistant` (для AI оператор = «от имени сервиса»);
 *   - `system` отбрасывается;
 *   - схлопываем consecutive same-role (Anthropic ругается на повтор ролей);
 *   - гарантируем, что последнее сообщение — `user` (текущий ввод уже записан
 *     в БД до вызова, но подстраховываемся).
 */
export function toAgentHistory(
  history: MessageHistoryItem[],
  currentUserText: string,
): AgentMessage[] {
  const mapped = history
    .filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'operator')
    .map((m) => ({
      role: (m.role === 'operator' ? 'assistant' : m.role) as 'user' | 'assistant',
      content: m.content,
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

  const last = collapsed[collapsed.length - 1];
  if (!last || last.role !== 'user') {
    collapsed.push({ role: 'user', content: currentUserText });
  }

  return collapsed;
}
