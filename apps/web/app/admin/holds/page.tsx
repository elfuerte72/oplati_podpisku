import Link from 'next/link';

import { getDb, listHoldsForPanel } from '@oplati/db';

import { LocalAge, LocalTime } from '@/components/panel/LocalTime';
import { PanelForbidden, PanelShell } from '@/components/panel/PanelShell';
import {
  formatKopecks,
  formatUsdCents,
  orderStatusLabel,
  providerStatusLabel,
} from '@/lib/panel/format';
import { panelPageAccess } from '@/lib/panel/guard';
import { clientReachability } from '@/lib/panel/reachability';
import { readVccBalanceForPanel } from '@/lib/panel/vcc-balance';

/**
 * `/admin/holds` — антифрод-холды Freekassa и остаток карточного счёта
 * (спека §5.4).
 *
 * ⚠️ Действий по холду тут НЕТ: исход решает провайдер. Экран даёт видимость с
 * первого дня (сегодня об этом узнают через семь дней и только владелец) и
 * готовый текст для обращения в поддержку Freekassa.
 */

export const dynamic = 'force-dynamic';

/** Статус `7` — холд антифрода, подтверждён поддержкой Freekassa 2026-08-14. */
const ANTIFRAUD_HOLD = 7;

export default async function PanelHoldsPage() {
  const access = await panelPageAccess('holds');
  if (!access.allowed) {
    return (
      <PanelShell actor={access.actor} current="/admin/holds" live={false}>
        <PanelForbidden title="Холды банка" />
      </PanelShell>
    );
  }

  // Баланс и список — параллельно: чужой API не должен задерживать наш SQL.
  const [{ items: holds, hasMore }, balance] = await Promise.all([
    listHoldsForPanel(getDb()),
    readVccBalanceForPanel(),
  ]);

  return (
    <PanelShell actor={access.actor} current="/admin/holds">
      <section className="panel-card" style={{ marginBottom: 16 }}>
        <h2 className="panel-title">Карточный счёт</h2>
        {balance.state === 'ok' ? (
          <p>
            <span
              className={`panel-status panel-status--${balance.low ? 'danger' : 'ok'}`}
              style={{ fontSize: 16 }}
            >
              {formatUsdCents(balance.balanceUsdCents)}
            </span>{' '}
            <span className="panel-muted">
              {balance.pendingUsdCents > 0
                ? `в пути ${formatUsdCents(balance.pendingUsdCents)} · `
                : ''}
              {balance.thresholdUsdCents > 0
                ? `порог ${formatUsdCents(balance.thresholdUsdCents)}`
                : 'порог не задан — предупреждение выключено'}
            </span>
          </p>
        ) : balance.state === 'unavailable' ? (
          // Недоступный провайдер не роняет страницу: холды важнее баланса.
          <p className="panel-muted">Баланс не получен — PaySpace не ответил.</p>
        ) : (
          <p className="panel-muted">PaySpace не настроен в этом окружении.</p>
        )}
        {balance.state === 'ok' && balance.low ? (
          <p className="panel-error" style={{ marginTop: 8 }}>
            Ниже порога. Пополнение приходит на следующий день, а каждая новая карта
            списывает сумму заказа с буфером и надбавкой за выпуск.
          </p>
        ) : null}
      </section>

      <section className="panel-card" style={{ marginBottom: 16 }}>
        <h1 className="panel-title">Холды банка</h1>
        <p className="panel-muted">
          Заказ на проверке банка не протухает, и закрыть его с нашей стороны нельзя —
          исход решает провайдер. Статус <code>7</code> означает проверку антифрода.
        </p>
      </section>

      {holds.length === 0 ? (
        <div className="panel-card">
          {/* Пусто — это норма: на 16 августа холдов было ноль. */}
          <p className="panel-empty">Холдов нет.</p>
        </div>
      ) : (
        <div className="panel-card panel-table-scroll">
          <table className="panel-table">
            <thead>
              <tr>
                <th>Заказ</th>
                <th>Клиент</th>
                <th>Сумма</th>
                <th>Статус заказа</th>
                <th>Статус у провайдера</th>
                <th>Сменился</th>
                <th>Возраст</th>
                <th>Клиенту ушло</th>
              </tr>
            </thead>
            <tbody>
              {holds.map((hold) => {
                const reach = clientReachability(hold.client);
                return (
                  <tr key={hold.orderId}>
                    <td>
                      <Link href={`/admin/orders/${hold.shortId}`}>{hold.shortId}</Link>
                    </td>
                    <td>
                      <Link href={`/admin/clients/${hold.client.id}`}>
                        {hold.client.displayName ?? hold.client.telegramId ?? 'без имени'}
                      </Link>
                    </td>
                    <td>{formatKopecks(hold.amountRubKopecks)}</td>
                    <td>{orderStatusLabel(hold.orderStatus)}</td>
                    <td>{providerStatusLabel(hold.lastProviderStatus)}</td>
                    <td className="panel-muted">
                      {hold.lastProviderStatusAt ? (
                        <LocalTime iso={hold.lastProviderStatusAt.toISOString()} />
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      <LocalAge iso={hold.orderCreatedAt.toISOString()} />
                    </td>
                    <td className="panel-muted">
                      {/* Чтобы менеджер не дублировал руками то, что автомат уже
                          отправил. Клиенту без Telegram не уходит ничего. */}
                      {!reach.reachable
                        ? 'нечем — нет Telegram'
                        : hold.orderStatus === 'payment_review' &&
                            hold.lastProviderStatus === ANTIFRAUD_HOLD
                          ? 'автосообщение о проверке банка'
                          : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {hasMore ? (
        <p className="panel-muted" style={{ marginTop: 12 }}>
          Показаны не все: холдов больше, чем помещается на экран.
        </p>
      ) : null}

      <section className="panel-card" style={{ marginTop: 16 }}>
        <h2 className="panel-title">Текст для поддержки Freekassa</h2>
        <p className="panel-muted">
          Скопируй и подставь номер заказа и сумму — провайдер отвечает быстрее, когда
          вопрос сформулирован конкретно.
        </p>
        <code className="panel-secret" style={{ whiteSpace: 'pre-wrap' }}>
          {[
            'Здравствуйте! Касса 74953.',
            'Платёж по заказу <номер> на сумму <сумма> ₽ находится в статусе 7 с <дата>.',
            'Подскажите, пожалуйста: это проверка антифрода, какие данные нужны от нас',
            'и в какой срок ожидать решения? Клиент ждёт.',
          ].join('\n')}
        </code>
      </section>
    </PanelShell>
  );
}
