import Link from 'next/link';

import {
  countPendingOrdersForPanel,
  countUnansweredSupportRequests,
  getDb,
  listHoldsForPanel,
  listPendingOrdersForPanel,
  listSupportRequestsForPanel,
} from '@oplati/db';

import { PanelShell } from '@/components/panel/PanelShell';
import { isDeskQuiet } from '@/lib/panel/desk';
import { formatKopecks, formatUsdCents } from '@/lib/panel/format';
import { requirePanelActor } from '@/lib/panel/guard';
import { canAccess } from '@/lib/panel/permissions';
import { readVccBalanceForPanel } from '@/lib/panel/vcc-balance';

/**
 * `/admin` — рабочий стол (спека §5.1). Отвечает на один вопрос: «что мне
 * делать сейчас».
 *
 * ⚠️ **Пустой стол — норма, а не поломка.** На 16 августа живых заказов было
 * ноль, холдов ноль, обращений четыре за три месяца. Экран обязан говорить
 * «всё спокойно», а не выглядеть сломанным.
 *
 * ⚠️ Графиков здесь нет ни одного: на вопрос «как идут дела» отвечает Metabase.
 *
 * Каждый блок спрашивается ТОЛЬКО при праве на соответствующий раздел, и
 * «не смотрели» отличается от «ноль»: иначе роль без доступа читала бы
 * «всё спокойно» как утверждение о том, чего мы не проверяли.
 *
 */

export const dynamic = 'force-dynamic';

export default async function PanelHomePage() {
  // Стартовый экран не требует отдельного права: его видит любой вошедший
  // сотрудник. Просить у гейта чужое право ради получения актора — способ
  // однажды получить отказ там, где его не задумывали. А вот СОДЕРЖИМОЕ блока
  // спрашивается только при праве на соответствующий раздел.
  const actor = await requirePanelActor();
  const db = getDb();

  const canPending = canAccess(actor.role, 'pending');
  const canHolds = canAccess(actor.role, 'holds');
  const canSupport = canAccess(actor.role, 'support');

  const [pending, pendingTotals, holds, balance, support, unansweredCount] = await Promise.all([
    canPending ? listPendingOrdersForPanel(db, { limit: 5 }) : Promise.resolve(null),
    // Число и деньги — из БАЗЫ, а не по пяти видимым строкам: «5+ на 50 000 ₽»
    // при сорока заказах на 200 000 ₽ занижает ровно то, ради чего блок и
    // существует. Тот же запрет, что пачка 3 ввела на карточке клиента.
    canPending ? countPendingOrdersForPanel(db) : Promise.resolve(null),
    canHolds ? listHoldsForPanel(db, 5) : Promise.resolve(null),
    canHolds ? readVccBalanceForPanel() : Promise.resolve(null),
    canSupport ? listSupportRequestsForPanel(db, { limit: 5 }) : Promise.resolve(null),
    // Счётчик — из БАЗЫ: «новых» может не оказаться среди пяти свежих строк
    // (клиент написал вчера, ему не ответили, сегодня пришло пять отвеченных),
    // и стол утверждал бы «все обращения отвечены» ровно в том случае, ради
    // которого блок и заведён.
    canSupport ? countUnansweredSupportRequests(db) : Promise.resolve(null),
  ]);

  const balanceLow =
    balance === null
      ? null
      : balance.state === 'ok' || balance.state === 'stale'
        ? balance.low
        : false;
  const quiet = isDeskQuiet({
    pendingCount: pendingTotals?.count ?? null,
    holdsCount: holds ? holds.items.length : null,
    balanceLow,
    unansweredSupportCount: unansweredCount,
  });

  return (
    <PanelShell actor={actor}>
      <section className="panel-card" style={{ marginBottom: 16 }}>
        <h1 className="panel-title">Что требует внимания</h1>
        {quiet ? (
          <p className="panel-muted">
            Всё спокойно: недожатых заказов нет, банк ничего не держит, денег на карточном счёте
            хватает. Это нормальное состояние — поток около одного заказа в день.
          </p>
        ) : (
          <p className="panel-muted">Ниже — только то, что сейчас требует действия.</p>
        )}
      </section>

      <div className="panel-grid">
        {canPending ? (
          <section className="panel-card">
            <h2 className="panel-title">Недожатые заказы</h2>
            {pendingTotals && pendingTotals.count > 0 ? (
              <>
                <p>
                  <span className="panel-status panel-status--warn" style={{ fontSize: 16 }}>
                    {pendingTotals.count}
                  </span>{' '}
                  <span className="panel-muted">
                    на {formatKopecks(pendingTotals.sumKopecks)}
                  </span>
                </p>
                {pending?.items[0] ? (
                  <p className="panel-muted">
                    Самый старый:{' '}
                    <Link href={`/admin/orders/${pending.items[0].shortId}`}>
                      {pending.items[0].shortId}
                    </Link>
                  </p>
                ) : null}
              </>
            ) : (
              <p className="panel-empty">Все заказы оплачены.</p>
            )}
            <p style={{ marginTop: 8 }}>
              <Link href="/admin/pending">Открыть список</Link>
            </p>
          </section>
        ) : null}

        {canHolds ? (
          <section className="panel-card">
            <h2 className="panel-title">Холды банка</h2>
            {holds && holds.items.length > 0 ? (
              <p>
                <span className="panel-status panel-status--danger" style={{ fontSize: 16 }}>
                  {holds.items.length}
                  {holds.hasMore ? '+' : ''}
                </span>{' '}
                <span className="panel-muted">платежей на проверке или с отказом</span>
              </p>
            ) : (
              <p className="panel-empty">Банк ничего не держит.</p>
            )}
            <p style={{ marginTop: 8 }}>
              <Link href="/admin/holds">Открыть список</Link>
            </p>
          </section>
        ) : null}

        {canSupport ? (
          <section className="panel-card">
            <h2 className="panel-title">Новые обращения</h2>
            {unansweredCount !== null && unansweredCount > 0 ? (
              <p>
                <span className="panel-status panel-status--warn" style={{ fontSize: 16 }}>
                  {unansweredCount}
                </span>{' '}
                <span className="panel-muted">без ответа</span>
              </p>
            ) : (
              <p className="panel-empty">Все обращения отвечены.</p>
            )}
            <p style={{ marginTop: 8 }}>
              <Link href="/admin/support">Открыть список</Link>
            </p>
          </section>
        ) : null}

        {canHolds ? (
          <section className="panel-card">
            <h2 className="panel-title">Карточный счёт</h2>
            {balance?.state === 'ok' || balance?.state === 'stale' ? (
              <>
                <p>
                  <span
                    className={`panel-status panel-status--${balance.low ? 'danger' : 'ok'}`}
                    style={{ fontSize: 16 }}
                  >
                    {formatUsdCents(balance.balanceUsdCents)}
                  </span>{' '}
                  <span className="panel-muted">
                    {balance.thresholdUsdCents > 0
                      ? `порог ${formatUsdCents(balance.thresholdUsdCents)}`
                      : 'порог не задан'}
                  </span>
                </p>
                {balance.low ? (
                  <p className="panel-error">
                    Ниже порога. Пополнение приходит на следующий день — заказ, оплаченный
                    сегодня, может не получить карту.
                  </p>
                ) : null}
              </>
            ) : balance?.state === 'unavailable' ? (
              <p className="panel-muted">Баланс не получен — PaySpace не ответил.</p>
            ) : (
              <p className="panel-muted">PaySpace не настроен в этом окружении.</p>
            )}
          </section>
        ) : null}
      </div>
    </PanelShell>
  );
}
