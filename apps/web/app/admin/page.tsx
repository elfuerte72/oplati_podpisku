import Link from 'next/link';

import { PanelShell } from '@/components/panel/PanelShell';
import { requirePanelActor } from '@/lib/panel/guard';

/**
 * `/admin` — стартовая страница панели.
 *
 * Пока перечень разделов; рабочий стол (недожатые заказы, холды банка, баланс
 * карточного счёта) приезжает тикетом 08.
 */

export const dynamic = 'force-dynamic';

export default async function PanelHomePage() {
  // Стартовый экран не требует отдельного права: его видит любой вошедший
  // сотрудник. Просить у гейта чужое право ради получения актора — способ
  // однажды получить отказ там, где его не задумывали.
  const actor = await requirePanelActor();

  return (
    <PanelShell actor={actor} live={false}>
      <div className="panel-card">
        <h1 className="panel-title">Вы вошли как {actor.displayName}</h1>
        <p className="panel-muted">
          Рабочий стол «что мне делать сейчас» появится тикетом 08. Пока — прямо в разделы:{' '}
          <Link href="/admin/orders">заказы</Link>.
        </p>
      </div>
    </PanelShell>
  );
}
