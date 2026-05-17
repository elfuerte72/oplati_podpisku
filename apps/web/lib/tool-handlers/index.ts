import 'server-only';

import type { ToolHandlers } from '@oplati/agent';

import { searchCatalog } from './search-catalog.ts';
import { proposeOrder } from './propose-order.ts';
import { confirmOrder } from './confirm-order.ts';
import { requestHuman } from './request-human.ts';

/**
 * Фабрика реальных tool-handlers'ов для AI-агента (MVP: Love & Pay + paypace).
 *
 * Контракт строго совпадает с интерфейсом `ToolHandlers` из `@oplati/agent`
 * (см. `packages/agent/src/index.ts`). Agent сам не импортирует БД — передаёт
 * сюда `userId`/`conversationId`, мы открываем БД через `getDb()` внутри.
 */

export type ToolContext = {
  userId: string;
  conversationId: string;
};

export function createToolHandlers(ctx: ToolContext): ToolHandlers {
  return {
    search_catalog: (input) => searchCatalog(input),
    propose_order: (input) => proposeOrder({ ...input, userId: ctx.userId, conversationId: ctx.conversationId }),
    confirm_order: (input) => confirmOrder(input),
    request_human: (input) =>
      requestHuman({ ...input, userId: ctx.userId, conversationId: ctx.conversationId }),
  };
}
