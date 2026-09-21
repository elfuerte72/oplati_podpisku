import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';

import {
  getClientActivityForPanel,
  getClientDetailForPanel,
  getUserBillingAddress,
  getDb,
  listClientFeedbackByUserForPanel,
} from '@oplati/db';

import { LocalAge, LocalTime } from '@/components/panel/LocalTime';
import { PanelPageHeader } from '@/components/panel/PanelPageHeader';
import { PanelForbidden, PanelShell } from '@/components/panel/PanelShell';
import { activityChannelLabel, activityDetails, activityTitle } from '@/lib/panel/client-activity';
import { ensureClientTelegramUsername } from '@/lib/panel/client-username';
import { feedbackAnswerText, isLowRating } from '@/lib/panel/feedback-text';
import {
  cardStatusLabel,
  formatCount,
  formatKopecks,
  formatUsdCents,
  orderStatusLabel,
  orderStatusTone,
} from '@/lib/panel/format';
import { STATUS_TONE_CLASS, supportModeClass } from '@/lib/panel/class-names';
import { lookupLabel } from '@/lib/panel/format';
import { effectiveSupportMode } from '@/lib/panel/support-mode';
import { panelPageAccess } from '@/lib/panel/guard';
import {
  ACTION_TITLES,
  CELL_TEXT,
  CLIENT_CARD_TEXT,
  COLUMN_TITLES,
  FEEDBACK_KIND_LABELS,
  FEEDBACK_TEXT,
  PAGE_TITLES,
  SUPPORT_MODE_LABELS,
} from '@/lib/panel/labels';
import { clientReachability } from '@/lib/panel/reachability';
import { clientDirectMessage } from '@/lib/panel/telegram-dm';

/**
 * `/admin/clients/<id>` — всё про человека на одной странице (спека §5.3):
 * контакты, итоги, партнёрство, поддержка, VPN, заказы, карты, лента действий
 * и ответы на касания воронки.
 *
 * ⚠️ Полные `pan`/`cvc` не показываются: карты только маскированные. Ссылка
 * VPN-подписки и IP клиента наружу не отдаются — репозиторий их не читает.
 *
 * ⚠️ Если у клиента нет Telegram — это написано прямо, и кнопка ответа не
 * рисуется. На проде таких 47 из 103, и «кнопка, которая молча ничего не
 * делает» — худший вариант из возможных.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: PAGE_TITLES.client };

const clientIdSchema = z.string().uuid();

export default async function PanelClientPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const access = await panelPageAccess('clients');
  if (!access.allowed) {
    return (
      <PanelShell actor={access.actor} current="/admin/clients" live={false}>
        <PanelForbidden title={PAGE_TITLES.client} />
      </PanelShell>
    );
  }

  // Идентификатор из адреса — граница (инвариант 5).
  const { id } = await params;
  const parsedId = clientIdSchema.safeParse(id);
  if (!parsedId.success) notFound();

  const db = getDb();
  // Три выборки независимы — идут параллельно; отсутствие клиента решает
  // первая, остальные у несуществующего id просто пусты.
  const [detail, activity, feedback, billingAddress] = await Promise.all([
    getClientDetailForPanel(db, parsedId.data),
    getClientActivityForPanel(db, parsedId.data),
    listClientFeedbackByUserForPanel(db, parsedId.data),
    // Адрес закрепляется случайно и больше нигде не виден: клиенту он уходит
    // одним сообщением при выпуске карты. Потерял сообщение — назвать адрес
    // заново может только тот, кто видит эту строку.
    getUserBillingAddress(db, parsedId.data),
  ]);
  if (!detail) notFound();

  const { client } = detail;
  const reach = clientReachability(client);
  // Эффективный режим, как в разделе «Поддержка»: истёкшая сессия помощника —
  // свободный разговор, а не «Помощник» (SUP-13).
  const lastSupportMode = activity.support.lastMode
    ? effectiveSupportMode(activity.support.lastMode, activity.support.lastModeExpiresAt)
    : null;
  // Личка — главное действие карточки: половина обращений решается одной
  // фразой человеку, а не перепиской через бота. Username сверяется с Telegram
  // (best-effort, свой поводок), поэтому ссылка есть и у клиентов, заведённых
  // до появления колонки.
  const username = await ensureClientTelegramUsername({
    userId: client.id,
    telegramId: client.telegramId,
    telegramUsername: client.telegramUsername,
    telegramUsernameCheckedAt: client.telegramUsernameCheckedAt,
  });
  const dm = clientDirectMessage({ telegramId: client.telegramId, telegramUsername: username });
  // Список заказов режется потолком выборки, поэтому итоги берутся ИЗ БАЗЫ
  // (`detail.totals`), а не складываются по видимым строкам: у клиента со 100+
  // заказами сумма по срезу молча занижала бы деньги, а «Заказов» показывало бы
  // ровно потолок.
  const hiddenOrders = detail.totals.ordersCount - detail.orders.length;

  return (
    <PanelShell actor={access.actor} current="/admin/clients">
      <PanelPageHeader
        title={client.displayName ?? CELL_TEXT.clientNoName}
        aside={
          dm.available ? (
            // Обычная ссылка, а не кнопка со скриптом: адрес виден в статусной
            // строке, работает средний клик и «открыть в приложении».
            // `rel=noreferrer` — адрес карточки клиента не должен уезжать в
            // Telegram реферером (в нём id клиента).
            <a
              className="panel-button panel-button--primary"
              href={dm.url}
              target="_blank"
              rel="noreferrer"
            >
              {ACTION_TITLES.writeDirect} {dm.handle}
            </a>
          ) : detail.conversationId ? (
            <Link className="panel-button" href={`/admin/support/${detail.conversationId}`}>
              {ACTION_TITLES.openConversation}
            </Link>
          ) : null
        }
      >
        <p className="panel-muted">
          {client.telegramId ? `Telegram ${client.telegramId}` : client.hasWebSession ? 'Только сайт' : 'Без канала связи'} · с{' '}
          <LocalTime iso={client.createdAt.toISOString()} />
          {activity.lastActivityAt ? (
            // Тем же выражением, что колонка «Последний след» списка: под одним
            // ярлыком список и карточка обязаны показывать одно время.
            <>
              {' '}
              · {CLIENT_CARD_TEXT.lastSeenInline}{' '}
              <LocalAge iso={activity.lastActivityAt.toISOString()} />
            </>
          ) : null}
        </p>
        {!dm.available && dm.reason === 'no_username' ? (
          // Честный отказ вместо мёртвой кнопки: `tg://user?id=` для чужого
          // человека молча не открывается — писать остаётся через бота.
          <p className="panel-muted" style={{ marginTop: 4 }}>
            {CELL_TEXT.noTelegramUsername}. {CELL_TEXT.writeViaBotHint}
          </p>
        ) : null}
        {reach.reachable ? null : (
          <p className="panel-error" style={{ marginTop: 8 }}>
            {reach.reason}: клиент оформил заказ на сайте и Telegram не привязал.
          </p>
        )}
      </PanelPageHeader>

      <div className="panel-grid">
        <section className="panel-card">
          <h2 className="panel-title">Контакты</h2>
          {/* На проде 101 из 103 клиентов без email — пустые контакты это
              норма, а не сбой, и экран не должен выглядеть сломанным. */}
          <dl className="panel-dl">
            <dt>Email</dt>
            <dd>{client.email ?? <span className="panel-muted">{CELL_TEXT.notLeft}</span>}</dd>
            <dt>Телефон</dt>
            <dd>
              {client.phone ?? <span className="panel-muted">{CELL_TEXT.notLeft}</span>}
              {client.phone && client.phoneSource ? (
                <span className="panel-muted">
                  {' '}
                  ·{' '}
                  {client.phoneSource === 'telegram'
                    ? CELL_TEXT.phoneFromTelegram
                    : CELL_TEXT.phoneManual}
                </span>
              ) : null}
            </dd>
            <dt>{CLIENT_CARD_TEXT.billingAddress}</dt>
            <dd>
              {billingAddress ? (
                `${billingAddress.streetLine1}, ${billingAddress.city}, ${billingAddress.stateCode} ${billingAddress.postalCode}`
              ) : (
                <span className="panel-muted">{CLIENT_CARD_TEXT.billingAddressNone}</span>
              )}
            </dd>
            <dt>Язык</dt>
            <dd>{client.language}</dd>
            <dt>{CLIENT_CARD_TEXT.funnel}</dt>
            <dd>
              {client.funnelOptOutAt ? (
                <>
                  {CLIENT_CARD_TEXT.funnelOptedOut}{' '}
                  <span className="panel-muted">
                    · <LocalTime iso={client.funnelOptOutAt.toISOString()} />
                  </span>
                </>
              ) : (
                CLIENT_CARD_TEXT.funnelActive
              )}
            </dd>
          </dl>
        </section>

        <section className="panel-card">
          <h2 className="panel-title">Итоги</h2>
          <dl className="panel-dl">
            <dt>Заказов</dt>
            <dd>{detail.totals.ordersCount}</dd>
            <dt>Оплачено</dt>
            <dd>{formatKopecks(detail.totals.purchasedRubKopecks)}</dd>
            <dt>Карт</dt>
            <dd>{detail.totals.cardsCount}</dd>
          </dl>
        </section>

        <section className="panel-card">
          <h2 className="panel-title">Партнёрство</h2>
          <dl className="panel-dl">
            <dt>Кто привёл</dt>
            <dd>
              {detail.referredBy ? (
                <Link href={`/admin/clients/${detail.referredBy.id}`}>
                  {detail.referredBy.displayName ??
                    detail.referredBy.telegramId ??
                    CELL_TEXT.noName}
                </Link>
              ) : (
                <span className="panel-muted">{CELL_TEXT.none}</span>
              )}
            </dd>
            <dt>Кого привёл</dt>
            <dd>
              {detail.referrals.length === 0 ? (
                <span className="panel-muted">{CELL_TEXT.nobody}</span>
              ) : (
                detail.referrals.map((r, i) => (
                  <span key={r.id}>
                    {i > 0 ? ', ' : ''}
                    <Link href={`/admin/clients/${r.id}`}>
                      {r.displayName ?? r.telegramId ?? CELL_TEXT.noName}
                    </Link>
                  </span>
                ))
              )}
            </dd>
            <dt>{CLIENT_CARD_TEXT.referralCode}</dt>
            <dd>
              {client.referralCode ?? <span className="panel-muted">{CELL_TEXT.notSpecified}</span>}
            </dd>
          </dl>
        </section>

        <section className="panel-card">
          <h2 className="panel-title">{CLIENT_CARD_TEXT.support}</h2>
          <dl className="panel-dl">
            <dt>{CLIENT_CARD_TEXT.conversations}</dt>
            <dd>{formatCount(activity.support.conversationsCount)}</dd>
            <dt>{CLIENT_CARD_TEXT.clientMessages}</dt>
            <dd>{formatCount(activity.support.clientMessagesCount)}</dd>
            <dt>{CLIENT_CARD_TEXT.lastClientMessage}</dt>
            <dd>
              {activity.support.lastClientMessageAt ? (
                <LocalTime iso={activity.support.lastClientMessageAt.toISOString()} />
              ) : (
                <span className="panel-muted">{CELL_TEXT.noMessages}</span>
              )}
            </dd>
            <dt>{CLIENT_CARD_TEXT.mode}</dt>
            <dd>
              {lastSupportMode ? (
                <span className={supportModeClass(lastSupportMode)}>
                  {lookupLabel(SUPPORT_MODE_LABELS, lastSupportMode) ?? lastSupportMode}
                </span>
              ) : (
                <span className="panel-muted">—</span>
              )}
            </dd>
          </dl>
          {detail.conversationId ? (
            <p style={{ marginTop: 12 }}>
              <Link className="panel-button" href={`/admin/support/${detail.conversationId}`}>
                {ACTION_TITLES.openConversation}
              </Link>
            </p>
          ) : null}
        </section>

        <section className="panel-card">
          <h2 className="panel-title">{CLIENT_CARD_TEXT.vpn}</h2>
          {activity.vpn ? (
            <dl className="panel-dl">
              <dt>{CLIENT_CARD_TEXT.vpnStatus}</dt>
              <dd>{activity.vpn.status}</dd>
              <dt>{CLIENT_CARD_TEXT.vpnIssuedAt}</dt>
              <dd>
                <LocalTime iso={activity.vpn.createdAt.toISOString()} />
              </dd>
              <dt>{CLIENT_CARD_TEXT.vpnExpireAt}</dt>
              <dd>
                <LocalTime iso={activity.vpn.expireAt.toISOString()} />
              </dd>
            </dl>
          ) : (
            <p className="panel-muted">{CELL_TEXT.vpnNotIssued}</p>
          )}
        </section>
      </div>

      <section className="panel-card" style={{ marginTop: 16 }}>
        <h2 className="panel-title">Заказы</h2>
        {detail.orders.length === 0 ? (
          <p className="panel-muted">{CELL_TEXT.noOrders}</p>
        ) : (
          <div className="panel-table-scroll">
            <table className="panel-table">
              <thead>
                <tr>
                  <th>{COLUMN_TITLES.order}</th>
                  <th>{COLUMN_TITLES.service}</th>
                  <th className="panel-num">{COLUMN_TITLES.amount}</th>
                  <th>{COLUMN_TITLES.status}</th>
                  <th>{COLUMN_TITLES.created}</th>
                </tr>
              </thead>
              <tbody>
                {detail.orders.map((order) => (
                  <tr key={order.id}>
                    <td>
                      <Link href={`/admin/orders/${order.shortId}`}>{order.shortId}</Link>
                    </td>
                    <td>{order.serviceName ?? '—'}</td>
                    <td className="panel-num">{formatKopecks(order.amountRubKopecks)}</td>
                    <td>
                      <span
                        className={STATUS_TONE_CLASS[orderStatusTone(order.status)]}
                      >
                        {orderStatusLabel(order.status)}
                      </span>
                    </td>
                    <td className="panel-muted">
                      <LocalTime iso={order.createdAt.toISOString()} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {hiddenOrders > 0 ? (
          // Усечение проговаривается вслух: молчаливый срез читается как «это
          // все заказы клиента» и врёт тем сильнее, чем ценнее клиент.
          // Отправлять в общий список намеренно НЕ обещаем: фильтра по клиенту
          // там нет, а поиск умеет только номер, telegram, email и имя — у
          // веб-клиента без контактов искать нечем.
          <p className="panel-muted" style={{ marginTop: 8 }}>
            Показаны последние {detail.orders.length} из {detail.totals.ordersCount}; ещё{' '}
            {hiddenOrders} не помещаются на экран.
          </p>
        ) : null}
      </section>

      <section className="panel-card" style={{ marginTop: 16 }}>
        <h2 className="panel-title">Карты</h2>
        {detail.cards.length === 0 ? (
          <p className="panel-muted">{CELL_TEXT.noCards}</p>
        ) : (
          <div className="panel-table-scroll">
            <table className="panel-table">
              <thead>
                <tr>
                  <th>{COLUMN_TITLES.cardNumber}</th>
                  <th>{COLUMN_TITLES.status}</th>
                  <th className="panel-num">{COLUMN_TITLES.cardBalance}</th>
                  <th>{COLUMN_TITLES.cardIssuedAt}</th>
                </tr>
              </thead>
              <tbody>
                {detail.cards.map((card) => (
                  <tr key={card.id}>
                    <td>{card.panMasked}</td>
                    <td>{cardStatusLabel(card.status)}</td>
                    <td className="panel-num">{formatUsdCents(card.balanceUsdCents)}</td>
                    <td className="panel-muted">
                      <LocalTime iso={card.createdAt.toISOString()} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel-card" style={{ marginTop: 16 }}>
        <h2 className="panel-title">{CLIENT_CARD_TEXT.activity}</h2>
        {activity.events.length === 0 ? (
          <p className="panel-muted">{CELL_TEXT.noActivity}</p>
        ) : (
          <div className="panel-table-scroll">
            <table className="panel-table">
              <thead>
                <tr>
                  <th>{COLUMN_TITLES.when}</th>
                  <th>{COLUMN_TITLES.event}</th>
                  <th>{COLUMN_TITLES.channel}</th>
                  <th>{COLUMN_TITLES.details}</th>
                  <th>{COLUMN_TITLES.order}</th>
                </tr>
              </thead>
              <tbody>
                {activity.events.map((event, index) => {
                  const channel = activityChannelLabel(event.channel);
                  const details = activityDetails(event.props);
                  return (
                    // Ключ с позицией: у события нет своего id (вьюха склеивает
                    // четыре таблицы), а пара «время + имя» повторяется у батча.
                    <tr key={`${event.occurredAt.toISOString()}-${event.name}-${index}`}>
                      <td className="panel-muted">
                        <LocalTime iso={event.occurredAt.toISOString()} />
                      </td>
                      <td>
                        {/* Веха из денежных таблиц выделена весом: это факт
                            с деньгами, а не клик по витрине. */}
                        {event.kind === 'milestone' ? (
                          <strong>{activityTitle(event.name)}</strong>
                        ) : (
                          activityTitle(event.name)
                        )}
                      </td>
                      <td className="panel-muted">{channel ?? '—'}</td>
                      <td className="panel-muted">{details ?? '—'}</td>
                      <td>
                        {event.orderShortId ? (
                          <Link href={`/admin/orders/${event.orderShortId}`}>{event.orderShortId}</Link>
                        ) : (
                          <span className="panel-muted">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {activity.hasMoreEvents ? (
          // Усечение проговаривается вслух — иначе лента читается как «это всё».
          <p className="panel-muted" style={{ marginTop: 8 }}>
            {CLIENT_CARD_TEXT.activityShown} {formatCount(activity.events.length)}.
          </p>
        ) : null}
      </section>

      <section className="panel-card" style={{ marginTop: 16 }}>
        <h2 className="panel-title">{CLIENT_CARD_TEXT.feedback}</h2>
        {feedback.length === 0 ? (
          <p className="panel-muted">{CELL_TEXT.noFeedback}</p>
        ) : (
          <div className="panel-table-scroll">
            <table className="panel-table">
              <thead>
                <tr>
                  <th>{FEEDBACK_TEXT.when}</th>
                  <th>{FEEDBACK_TEXT.kind}</th>
                  <th>{FEEDBACK_TEXT.answer}</th>
                  <th>{COLUMN_TITLES.order}</th>
                </tr>
              </thead>
              <tbody>
                {feedback.map((row) => (
                  <tr key={row.id}>
                    <td className="panel-muted">
                      <LocalTime iso={row.createdAt.toISOString()} />
                    </td>
                    <td>{FEEDBACK_KIND_LABELS[row.kind]}</td>
                    <td>
                      <span
                        className={isLowRating(row) ? STATUS_TONE_CLASS.danger : STATUS_TONE_CLASS.muted}
                      >
                        {feedbackAnswerText(row)}
                      </span>
                    </td>
                    <td>
                      {row.order ? (
                        <Link href={`/admin/orders/${row.order.shortId}`}>{row.order.shortId}</Link>
                      ) : (
                        <span className="panel-muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </PanelShell>
  );
}
