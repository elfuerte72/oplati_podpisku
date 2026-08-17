import { redirect } from 'next/navigation';

import { staffRoleLabel } from '@/lib/panel/roles';
import { readPanelActor } from '@/lib/panel/session';

/**
 * `/admin` — стартовая страница панели.
 *
 * Тикет 01: сюда попадает вошедший сотрудник, и здесь пока только «вы вошли
 * как …». Рабочий стол (недожатые заказы, холды банка, баланс карт) приезжает
 * тикетом 08.
 */

export const dynamic = 'force-dynamic';

export default async function PanelHomePage() {
  const actor = await readPanelActor();
  if (!actor) redirect('/admin/login');

  return (
    <div className="panel-shell">
      <header className="panel-header">
        <span className="panel-brand">Панель Оплатишки</span>
        <div className="panel-actor">
          <span>
            {actor.displayName} · {staffRoleLabel(actor.role)}
          </span>
          <form method="post" action="/api/panel/auth/logout">
            <button type="submit" className="panel-button">
              Выйти
            </button>
          </form>
        </div>
      </header>

      <main className="panel-main">
        <div className="panel-content">
          <div className="panel-card">
            <h1 className="panel-title">Вы вошли как {actor.displayName}</h1>
            <p className="panel-muted">
              Разделы появятся следующими тикетами: заказы, клиенты, антифрод-холды,
              поддержка, партнёры.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
