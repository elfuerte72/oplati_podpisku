/**
 * Позиция каталога в результате `search_catalog` — общий контракт продажного
 * агента и помощника поддержки. Свой модуль, чтобы `support-tools.ts` не тянул
 * barrel `index.ts` ради одного типа (цикл импортов, пусть и type-only).
 */
export interface CatalogItem {
  id: string;
  slug: string;
  name: string;
  requiresKyc: boolean;
}
