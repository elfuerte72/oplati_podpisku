import type { Metadata } from 'next';
import Link from 'next/link';

import { getDb, listPendingOrdersForPanel } from '@oplati/db';

import { LocalTime } from '@/components/panel/LocalTime';
import { PanelPageHeader } from '@/components/panel/PanelPageHeader';
import { PanelShell } from '@/components/panel/PanelShell';
import { isDeskQuiet } from '@/lib/panel/desk';
import { STATUS_TONE_CLASS } from '@/lib/panel/class-names';
import { formatCount, formatKopecks, formatUsdCents } from '@/lib/panel/format';
import { requirePanelActor } from '@/lib/panel/guard';
import { readHoldsCount, readPendingTotals, readUnansweredSupportCount } from '@/lib/panel/menu-counts';
import {
  ACTION_TITLES,
  CELL_TEXT,
  EMPTY_TEXT,
  DESK_CARD_TITLES,
  PAGE_HINT,
  PAGE_TITLES,
  SECTION_TITLES,
} from '@/lib/panel/labels';
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

export const metadata: Metadata = { title: PAGE_TITLES.desk };

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

  const [pending, pendingTotals, holdsCount, balance, unansweredCount] = await Promise.all([
    canPending ? listPendingOrdersForPanel(db, { limit: 5 }) : Promise.resolve(null),
    // Число и деньги — из БАЗЫ, а не по пяти видимым строкам: «5+ на 50 000 ₽»
    // при сорока заказах на 200 000 ₽ занижает ровно то, ради чего блок и
    // существует. Тот же запрет, что пачка 3 ввела на карточке клиента.
    // Читатель общий с меню (`menu-counts.ts`): иначе та же выборка шла бы
    // дважды на каждый рендер стола.
    canPending ? readPendingTotals() : Promise.resolve(null),
    // Число — из БАЗЫ тем же читателем, что и бейдж меню: список на пять строк
    // давал «5+» рядом с точным «12» в соседнем меню на одном экране. Тот же
    // запрет, что у блока «Ждут оплаты» строкой выше.
    canHolds ? readHoldsCount() : Promise.resolve(null),
    canHolds ? readVccBalanceForPanel() : Promise.resolve(null),
    // Счётчик — из БАЗЫ: «новых» может не оказаться среди пяти свежих строк
    // (клиент написал вчера, ему не ответили, сегодня пришло пять отвеченных),
    // и стол утверждал бы «все обращения отвечены» ровно в том случае, ради
    // которого блок и заведён.
    canSupport ? readUnansweredSupportCount() : Promise.resolve(null),
  ]);

  // ⚠️ `unavailable` — это `null` («не смотрели / не получили»), а НЕ `false`.
  // Иначе верх экрана пишет «всё спокойно: денег на карточном счёте хватает»
  // ровно тогда, когда PaySpace не ответил, — и карточка ниже в тот же момент
  // честно говорит «баланс не получен».
  const balanceLow =
    balance === null || balance.state === 'unavailable' || balance.state === 'not_configured'
      ? null
      : balance.low;
  const quiet = isDeskQuiet({
    pendingCount: pendingTotals?.count ?? null,
    holdsCount: holdsCount,
    balanceLow,
    unansweredSupportCount: unansweredCount,
  });

  return (
    <PanelShell actor={actor}>
      {/* Заголовок совпадает с пунктом меню: «Что требует внимания» в шапке
          при «Рабочем столе» в меню читалось как два разных экрана. */}
      <PanelPageHeader title={SECTION_TITLES.desk}>
        <p className="panel-muted">{quiet ? EMPTY_TEXT.desk : PAGE_HINT.desk}</p>
      </PanelPageHeader>

      <div className="panel-grid">
        {canPending ? (
          <section className="panel-card">
            <h2 className="panel-title">{SECTION_TITLES.pending}</h2>
            {/* `null` — «не получили», и это НЕ «всё оплачено»: утверждать
                факт, которого никто не читал, стол не имеет права. */}
            {pendingTotals === null ? (
              <p className="panel-muted">{CELL_TEXT.countUnavailable}</p>
            ) : pendingTotals.count > 0 ? (
              <>
                <p>
                  <span className="panel-status panel-status--warn panel-status--lg">
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
              <p className="panel-empty">{EMPTY_TEXT.pending}</p>
            )}
            <p style={{ marginTop: 8 }}>
              <Link href="/admin/pending">{ACTION_TITLES.openList}</Link>
            </p>
          </section>
        ) : null}

        {canHolds ? (
          <section className="panel-card">
            <h2 className="panel-title">{SECTION_TITLES.holds}</h2>
            {holdsCount !== null && holdsCount > 0 ? (
              <p>
                <span className="panel-status panel-status--danger panel-status--lg">
                  {formatCount(holdsCount)}
                </span>{' '}
                <span className="panel-muted">платежей на проверке или с отказом</span>
              </p>
            ) : (
              <p className="panel-empty">{EMPTY_TEXT.holds}</p>
            )}
            <p style={{ marginTop: 8 }}>
              <Link href="/admin/holds">{ACTION_TITLES.openList}</Link>
            </p>
          </section>
        ) : null}

        {canSupport ? (
          <section className="panel-card">
            <h2 className="panel-title">{DESK_CARD_TITLES.support}</h2>
            {unansweredCount === null ? (
              <p className="panel-muted">{CELL_TEXT.countUnavailable}</p>
            ) : unansweredCount > 0 ? (
              <p>
                <span className="panel-status panel-status--warn panel-status--lg">
                  {unansweredCount}
                </span>{' '}
                <span className="panel-muted">без ответа</span>
              </p>
            ) : (
              <p className="panel-empty">{EMPTY_TEXT.supportAllAnswered}</p>
            )}
            <p style={{ marginTop: 8 }}>
              <Link href="/admin/support">{ACTION_TITLES.openList}</Link>
            </p>
          </section>
        ) : null}

        {canHolds ? (
          <section className="panel-card">
            <h2 className="panel-title">{DESK_CARD_TITLES.vccBalance}</h2>
            {balance?.state === 'ok' || balance?.state === 'stale' ? (
              <>
                <p>
                  {/* Тот же кегль, что у трёх соседних показателей стола: это
                      число решает, сможем ли мы выдать карту по оплаченному
                      заказу, и мельче остальных ему быть нечего. */}
                  <span
                    className={`${STATUS_TONE_CLASS[balance.low ? 'danger' : 'ok']} panel-status--lg`}
                  >
                    {formatUsdCents(balance.balanceUsdCents)}
                  </span>{' '}
                  <span className="panel-muted">
                    {balance.pendingUsdCents > 0
                      ? `в пути ${formatUsdCents(balance.pendingUsdCents)} · `
                      : ''}
                    {balance.thresholdUsdCents > 0
                      ? `порог ${formatUsdCents(balance.thresholdUsdCents)}`
                      : CELL_TEXT.thresholdNotSetAlertOff}
                    {/* Устаревшее число лучше прочерка, но молчать о возрасте
                        нельзя: по этой цифре решают, хватит ли денег на
                        следующий заказ. Раньше пометка жила на экране проверки
                        платежей — теперь баланс показывается только здесь. */}
                    {balance.state === 'stale' ? (
                      <>
                        {' · '}
                        <span className="panel-status panel-status--warn">
                          данные на <LocalTime iso={balance.readAt.toISOString()} />, PaySpace
                          не отвечает
                        </span>
                      </>
                    ) : null}
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
              <p className="panel-muted">{CELL_TEXT.balanceUnavailable}</p>
            ) : (
              <p className="panel-muted">{CELL_TEXT.balanceNotConfigured}</p>
            )}
          </section>
        ) : null}
      </div>
    </PanelShell>
  );
}
