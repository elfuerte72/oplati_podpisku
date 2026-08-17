import { PanelForbidden, PanelShell } from '@/components/panel/PanelShell';
import { panelPageAccess } from '@/lib/panel/guard';

/**
 * `/admin/support` — раздел «Поддержка».
 *
 * Содержимое приезжает тикетом 10. Пункт меню существует уже сейчас
 * намеренно: он виден всем ролям, а право проверяется В ОПЕРАЦИИ — менеджер,
 * набравший адрес руками, получает объясняющую заглушку, а не пустой экран.
 */

export const dynamic = 'force-dynamic';

export default async function PanelSupportPage() {
  const { actor, allowed } = await panelPageAccess('support');

  return (
    <PanelShell actor={actor} current="/admin/support" live={false}>
      {allowed ? (
        <div className="panel-card">
          <h1 className="panel-title">Поддержка</h1>
          <p className="panel-muted">Раздел появится тикетом 10: обращения клиентов, лента переписки и ответ.</p>
        </div>
      ) : (
        <PanelForbidden title="Поддержка" />
      )}
    </PanelShell>
  );
}
