import { PanelForbidden, PanelShell } from '@/components/panel/PanelShell';
import { panelPageAccess } from '@/lib/panel/guard';

/**
 * `/admin/holds` — раздел «Холды банка».
 *
 * Содержимое приезжает тикетом 05. Пункт меню существует уже сейчас
 * намеренно: он виден всем ролям, а право проверяется В ОПЕРАЦИИ — менеджер,
 * набравший адрес руками, получает объясняющую заглушку, а не пустой экран.
 */

export const dynamic = 'force-dynamic';

export default async function PanelHoldsPage() {
  const { actor, allowed } = await panelPageAccess('holds');

  return (
    <PanelShell actor={actor} current="/admin/holds" live={false}>
      {allowed ? (
        <div className="panel-card">
          <h1 className="panel-title">Холды банка</h1>
          <p className="panel-muted">Раздел появится тикетом 05: платежи на проверке банка и остаток карточного счёта.</p>
        </div>
      ) : (
        <PanelForbidden title="Холды банка" />
      )}
    </PanelShell>
  );
}
