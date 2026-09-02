import type { Metadata } from 'next';

import { isSupportAiConfigured } from '@oplati/agent';

import { AnalystChat } from '@/components/panel/AnalystChat';
import { PanelPageHeader } from '@/components/panel/PanelPageHeader';
import { PanelForbidden, PanelShell } from '@/components/panel/PanelShell';
import { panelPageAccess } from '@/lib/panel/guard';
import { ANALYST_TEXT, SECTION_TITLES } from '@/lib/panel/labels';
import { serverEnv } from '@/lib/env.server';

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

  const configured = isSupportAiConfigured() && Boolean(serverEnv.PANEL_AI_DATABASE_URL);

  return (
    <PanelShell actor={access.actor} current="/admin/ai" live={false}>
      <PanelPageHeader title={SECTION_TITLES.ai}>
        <p className="panel-muted">{ANALYST_TEXT.intro}</p>
      </PanelPageHeader>

      <section className="panel-card">
        {configured ? <AnalystChat /> : <p className="panel-empty">{ANALYST_TEXT.notConfigured}</p>}
      </section>
    </PanelShell>
  );
}
