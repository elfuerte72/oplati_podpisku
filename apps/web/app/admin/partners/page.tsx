import { PanelForbidden, PanelShell } from '@/components/panel/PanelShell';
import { panelPageAccess } from '@/lib/panel/guard';

/**
 * `/admin/partners` — раздел «Партнёры».
 *
 * Содержимое приезжает тикетом 12. Пункт меню существует уже сейчас
 * намеренно: он виден всем ролям, а право проверяется В ОПЕРАЦИИ — менеджер,
 * набравший адрес руками, получает объясняющую заглушку, а не пустой экран.
 */

export const dynamic = 'force-dynamic';

export default async function PanelPartnersPage() {
  const { actor, allowed } = await panelPageAccess('partners');

  return (
    <PanelShell actor={actor} current="/admin/partners" live={false}>
      {allowed ? (
        <div className="panel-card">
          <h1 className="panel-title">Партнёры</h1>
          <p className="panel-muted">Раздел появится тикетом 12: дерево партнёров, начисления и заявки на вывод.</p>
        </div>
      ) : (
        <PanelForbidden title="Партнёры" />
      )}
    </PanelShell>
  );
}
