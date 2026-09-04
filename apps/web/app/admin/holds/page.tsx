import type { Metadata } from 'next';
import Link from 'next/link';

import { PANEL_DEFAULT_ROWS, getDb, listHoldsForPanel } from '@oplati/db';
import { FREEKASSA_ORDER_STATUS } from '@oplati/types';

import { LocalAge, LocalTime } from '@/components/panel/LocalTime';
import { PanelHelp } from '@/components/panel/PanelHelp';
import { PanelPageHeader } from '@/components/panel/PanelPageHeader';
import { PanelPager } from '@/components/panel/PanelPager';
import { PanelForbidden, PanelShell } from '@/components/panel/PanelShell';
import { STATUS_TONE_CLASS } from '@/lib/panel/class-names';
import {
  formatKopecks,
  orderStatusLabel,
  orderStatusTone,
  providerStatusLabel,
} from '@/lib/panel/format';
import { panelPageAccess } from '@/lib/panel/guard';
import { panelOffset, panelPageHref, parsePanelPage } from '@/lib/panel/paging';
import { serverEnv } from '@/lib/env';
import {
  CELL_TEXT,
  COLUMN_TITLES,
  EMPTY_TEXT,
  HELP_TEXT,
  HOLDS_SUPPORT_TEMPLATE,
  PAGE_HINT,
  SECTION_TITLES,
} from '@/lib/panel/labels';
import { clientReachability } from '@/lib/panel/reachability';

/**
 * `/admin/holds` — платежи на антифрод-проверке Freekassa (спека §5.4).
 *
 * ⚠️ Действий по холду тут НЕТ: исход решает провайдер. Экран даёт видимость с
 * первого дня (сегодня об этом узнают через семь дней и только владелец) и
 * готовый текст для обращения в поддержку Freekassa.
 *
 * Остаток карточного счёта отсюда уехал на рабочий стол (редизайн, тикет 02):
 * к проверке платежей он отношения не имеет, а экран обязан отвечать на один
 * вопрос.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: SECTION_TITLES.holds };

/**
 * Статус `7` — холд антифрода, подтверждён поддержкой Freekassa 2026-08-14.
 * Берётся из `@oplati/types`, а не переписывается числом: своя копия кода — то
 * самое незадекларированное зеркало, которое разъезжается молча.
 */
const ANTIFRAUD_HOLD = FREEKASSA_ORDER_STATUS.ANTIFRAUD_HOLD;

export default async function PanelHoldsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await panelPageAccess('holds');
  if (!access.allowed) {
    return (
      <PanelShell actor={access.actor} current="/admin/holds" live={false}>
        <PanelForbidden title={SECTION_TITLES.holds} />
      </PanelShell>
    );
  }

  const page = parsePanelPage((await searchParams).page);
  const { items: holds, hasMore } = await listHoldsForPanel(getDb(), {
    offset: panelOffset(page, PANEL_DEFAULT_ROWS),
  });

  return (
    <PanelShell actor={access.actor} current="/admin/holds">
      <PanelPageHeader title={SECTION_TITLES.holds}>
        <p className="panel-muted">{PAGE_HINT.holds}</p>
      </PanelPageHeader>

      <PanelHelp
        title={HELP_TEXT.holds.title}
        hint={HELP_TEXT.holds.hint}
        cards={HELP_TEXT.holds.cards}
      />

      {holds.length === 0 ? (
        /* Пусто — это норма: на 16 августа холдов было ноль. */
        <p className="panel-empty">{EMPTY_TEXT.holds}</p>
      ) : (
        <div className="panel-table-scroll">
          <table className="panel-table panel-table--cards">
            <thead>
              <tr>
                <th>{COLUMN_TITLES.order}</th>
                <th>{COLUMN_TITLES.client}</th>
                {/* Сервис и пилюля статуса — как у соседних списков: проверка
                    платежей была единственным экраном без них. */}
                <th>{COLUMN_TITLES.service}</th>
                <th className="panel-num">{COLUMN_TITLES.amount}</th>
                <th>{COLUMN_TITLES.orderStatus}</th>
                <th>{COLUMN_TITLES.providerStatus}</th>
                <th>{COLUMN_TITLES.providerStatusChangedAt}</th>
                <th>{COLUMN_TITLES.created}</th>
                <th>{COLUMN_TITLES.clientNotified}</th>
              </tr>
            </thead>
            <tbody>
              {holds.map((hold) => {
                const reach = clientReachability(hold.client);
                return (
                  <tr key={hold.orderId}>
                    <td data-label={COLUMN_TITLES.order}>
                      <Link href={`/admin/orders/${hold.shortId}`}>{hold.shortId}</Link>
                    </td>
                    <td data-label={COLUMN_TITLES.client}>
                      <Link href={`/admin/clients/${hold.client.id}`}>
                        {hold.client.displayName ?? hold.client.telegramId ?? CELL_TEXT.noName}
                      </Link>
                    </td>
                    <td data-label={COLUMN_TITLES.service}>{hold.serviceName ?? '—'}</td>
                    <td className="panel-num" data-label={COLUMN_TITLES.amount}>
                      {formatKopecks(hold.amountRubKopecks)}
                    </td>
                    <td data-label={COLUMN_TITLES.orderStatus}>
                      <span className={STATUS_TONE_CLASS[orderStatusTone(hold.orderStatus)]}>
                        {orderStatusLabel(hold.orderStatus)}
                      </span>
                    </td>
                    <td data-label={COLUMN_TITLES.providerStatus}>{providerStatusLabel(hold.lastProviderStatus)}</td>
                    <td data-label={COLUMN_TITLES.providerStatusChangedAt} className="panel-muted">
                      {hold.lastProviderStatusAt ? (
                        <LocalTime iso={hold.lastProviderStatusAt.toISOString()} />
                      ) : (
                        '—'
                      )}
                    </td>
                    <td data-label={COLUMN_TITLES.created}>
                      <LocalAge iso={hold.orderCreatedAt.toISOString()} />
                    </td>
                    <td data-label={COLUMN_TITLES.clientNotified} className="panel-muted">
                      {/* Чтобы менеджер не дублировал руками то, что автомат уже
                          отправил, — и, что важнее, чтобы он УВИДЕЛ клиента, до
                          которого сообщение не дошло. Поэтому здесь факт
                          доставки из журнала заказа, а не вывод из статусов:
                          отправка best-effort, «бот заблокирован» гасится
                          логом. */}
                      {hold.clientNotifiedAt ? (
                        <LocalTime iso={hold.clientNotifiedAt.toISOString()} />
                      ) : !reach.reachable ? (
                        CELL_TEXT.noTelegram
                      ) : hold.orderStatus === 'payment_review' &&
                        hold.lastProviderStatus === ANTIFRAUD_HOLD ? (
                        // Формулировка намеренно осторожная. Отметка появилась
                        // 18 августа, у заказов, попавших на холд раньше, её
                        // нет физически (журнал append-only, бэкфилла не
                        // бывает) — сказать «не ушло» значило бы отправить
                        // менеджера дублировать уже полученное клиентом
                        // сообщение.
                        <span
                          className="panel-status panel-status--warn"
                          title="Отметка об автосообщении ведётся с 18 августа. У более старых платежей её нет, даже если сообщение ушло."
                        >
                          {CELL_TEXT.noData}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <PanelPager
        page={page}
        hasMore={hasMore}
        hrefFor={(next) => panelPageHref('/admin/holds', {}, next)}
      />

      <section className="panel-card" style={{ marginTop: 16 }}>
        <h2 className="panel-title">{HOLDS_SUPPORT_TEMPLATE.title}</h2>
        <p className="panel-muted">{HOLDS_SUPPORT_TEMPLATE.hint}</p>
        {/* Номер кассы приходит ОТТУДА ЖЕ, откуда его берёт клиент шлюза:
            в разметке он был второй копией и разъехался бы молча при смене
            кассы. Не задан — шаблон честно просит подставить его руками. */}
        <code className="panel-secret" style={{ whiteSpace: 'pre-wrap' }}>
          {HOLDS_SUPPORT_TEMPLATE.body(serverEnv.FREEKASSA_SHOP_ID ?? null)}
        </code>
      </section>
    </PanelShell>
  );
}
