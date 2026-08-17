import { PanelForbidden, PanelShell } from '@/components/panel/PanelShell';
import { panelPageAccess } from '@/lib/panel/guard';

/**
 * `/admin/staff` — раздел «Персонал».
 *
 * Содержимое приезжает тикетом 01. Пункт меню существует уже сейчас
 * намеренно: он виден всем ролям, а право проверяется В ОПЕРАЦИИ — менеджер,
 * набравший адрес руками, получает объясняющую заглушку, а не пустой экран.
 */

export const dynamic = 'force-dynamic';

export default async function PanelStaffPage() {
  const { actor, allowed } = await panelPageAccess('staff');

  return (
    <PanelShell actor={actor} current="/admin/staff" live={false}>
      {allowed ? (
        <div className="panel-card">
          <h1 className="panel-title">Персонал</h1>
          <p className="panel-muted">Список сотрудников и отключение доступа. Заведение — скриптом db:staff.</p>
        </div>
      ) : (
        <PanelForbidden title="Персонал" />
      )}
    </PanelShell>
  );
}
