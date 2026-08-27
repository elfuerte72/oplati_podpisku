import type { Metadata } from 'next';

import { PanelPageHeader } from '@/components/panel/PanelPageHeader';
import { PanelForbidden, PanelShell } from '@/components/panel/PanelShell';
import { panelPageAccess } from '@/lib/panel/guard';
import { SECTION_TITLES } from '@/lib/panel/labels';

/**
 * `/admin/staff` — раздел «Персонал».
 *
 * Содержимое приезжает тикетом 01. Пункт меню существует уже сейчас
 * намеренно: он виден всем ролям, а право проверяется В ОПЕРАЦИИ — менеджер,
 * набравший адрес руками, получает объясняющую заглушку, а не пустой экран.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: SECTION_TITLES.staff };

export default async function PanelStaffPage() {
  const { actor, allowed } = await panelPageAccess('staff');

  return (
    <PanelShell actor={actor} current="/admin/staff" live={false}>
      {allowed ? (
        <PanelPageHeader title={SECTION_TITLES.staff}>
          <p className="panel-muted">
            Список сотрудников и отключение доступа. Заведение — скриптом <code>db:staff</code>.
          </p>
        </PanelPageHeader>
      ) : (
        <PanelForbidden title={SECTION_TITLES.staff} />
      )}
    </PanelShell>
  );
}
