import { PanelForbidden, PanelShell } from '@/components/panel/PanelShell';
import { panelPageAccess } from '@/lib/panel/guard';

/**
 * `/admin/pending` — раздел «Недожатые заказы».
 *
 * Содержимое приезжает тикетом 07. Пункт меню существует уже сейчас
 * намеренно: он виден всем ролям, а право проверяется В ОПЕРАЦИИ — менеджер,
 * набравший адрес руками, получает объясняющую заглушку, а не пустой экран.
 */

export const dynamic = 'force-dynamic';

export default async function PanelPendingPage() {
  const { actor, allowed } = await panelPageAccess('pending');

  return (
    <PanelShell actor={actor} current="/admin/pending" live={false}>
      {allowed ? (
        <div className="panel-card">
          <h1 className="panel-title">Недожатые заказы</h1>
          <p className="panel-muted">Раздел появится тикетом 07: список заказов без оплаты и кнопка напоминания.</p>
        </div>
      ) : (
        <PanelForbidden title="Недожатые заказы" />
      )}
    </PanelShell>
  );
}
