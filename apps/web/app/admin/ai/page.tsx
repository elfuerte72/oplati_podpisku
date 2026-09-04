import type { Metadata } from 'next';

import { AnalystChat } from '@/components/panel/AnalystChat';
import { PanelHelp } from '@/components/panel/PanelHelp';
import { PanelPageHeader } from '@/components/panel/PanelPageHeader';
import { PanelForbidden, PanelShell } from '@/components/panel/PanelShell';
import { isPanelAnalystConfigured } from '@/lib/panel/ai/profile';
import { panelPageAccess } from '@/lib/panel/guard';
import { ANALYST_TEXT, HELP_TEXT, PAGE_HINT, SECTION_TITLES } from '@/lib/panel/labels';

/**
 * `/admin/ai` — «Аналитик»: чат с AI, который сам пишет SQL к копии базы без
 * контактов и переписки и выполняет его под read-only ролью (панель v2,
 * ветка B). Живое обновление выключено: страница интерактивна и не читает БД.
 *
 * Без ключа модели или без подключения роли раздел честно пишет «не
 * настроено» и формы не показывает — вопрос, который заведомо получит 503,
 * задавать незачем.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: SECTION_TITLES.ai };

export default async function PanelAnalystPage() {
  const access = await panelPageAccess('ai');
  if (!access.allowed) {
    return (
      <PanelShell actor={access.actor} current="/admin/ai" live={false}>
        <PanelForbidden title={SECTION_TITLES.ai} />
      </PanelShell>
    );
  }

  // Та же проверка, что у операции: ключ модели И подключение роли.
  const configured = isPanelAnalystConfigured();

  return (
    <PanelShell actor={access.actor} current="/admin/ai" live={false}>
      <PanelPageHeader title={SECTION_TITLES.ai}>
        <p className="panel-muted">{PAGE_HINT.ai}</p>
      </PanelPageHeader>

      <PanelHelp title={HELP_TEXT.ai.title} hint={HELP_TEXT.ai.hint} cards={HELP_TEXT.ai.cards} />

      {configured ? <AnalystChat /> : <p className="panel-empty">{ANALYST_TEXT.notConfigured}</p>}
    </PanelShell>
  );
}
