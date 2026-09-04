import type { Metadata } from 'next';
import Link from 'next/link';

import { PANEL_DEFAULT_ROWS, getDb, listSupportRequestsForPanel } from '@oplati/db';

import { LocalAge, LocalTime } from '@/components/panel/LocalTime';
import { PanelHelp } from '@/components/panel/PanelHelp';
import { PanelPageHeader } from '@/components/panel/PanelPageHeader';
import { PanelPager } from '@/components/panel/PanelPager';
import { PanelForbidden, PanelShell } from '@/components/panel/PanelShell';
import { supportModeClass } from '@/lib/panel/class-names';
import { panelPageAccess } from '@/lib/panel/guard';
import { panelOffset, panelPageHref, parsePanelPage } from '@/lib/panel/paging';
import {
  ACTION_TITLES,
  CELL_TEXT,
  COLUMN_TITLES,
  EMPTY_TEXT,
  HELP_TEXT,
  PAGE_HINT,
  SECTION_TITLES,
  SUPPORT_MODE_LABELS,
} from '@/lib/panel/labels';
import { lookupLabel } from '@/lib/panel/format';

/**
 * `/admin/support` — обращения клиентов (спека §5.6).
 *
 * Единица списка — РАЗГОВОР, а не сообщение: «кто ведёт» и «подключиться»
 * живут на `conversations`. Обращение создаётся ТОЛЬКО нажатием кнопки или
 * командой `/support` (правило владельца) — свободный текст обращением не
 * становится, и панель показывает ровно то, что клиент отправил намеренно.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: SECTION_TITLES.support };

export default async function PanelSupportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await panelPageAccess('support');
  if (!access.allowed) {
    return (
      <PanelShell actor={access.actor} current="/admin/support" live={false}>
        <PanelForbidden title={SECTION_TITLES.support} />
      </PanelShell>
    );
  }

  const page = parsePanelPage((await searchParams).page);
  const { items, hasMore } = await listSupportRequestsForPanel(getDb(), {
    offset: panelOffset(page, PANEL_DEFAULT_ROWS),
  });

  return (
    <PanelShell actor={access.actor} current="/admin/support">
      <PanelPageHeader title={SECTION_TITLES.support}>
        <p className="panel-muted">{PAGE_HINT.support}</p>
      </PanelPageHeader>

      <PanelHelp
        title={HELP_TEXT.support.title}
        hint={HELP_TEXT.support.hint}
        cards={HELP_TEXT.support.cards}
      />

      {items.length === 0 ? (
        /* Четыре обращения за три месяца — пустой экран это норма. */
        <p className="panel-empty">{page > 1 ? EMPTY_TEXT.beyondLastPage : EMPTY_TEXT.support}</p>
      ) : (
        <div className="panel-table-scroll">
          <table className="panel-table">
            <thead>
              <tr>
                <th>{COLUMN_TITLES.client}</th>
                <th>{COLUMN_TITLES.writtenAt}</th>
                <th>{COLUMN_TITLES.repliedAt}</th>
                <th>{COLUMN_TITLES.mode}</th>
                <th>{COLUMN_TITLES.responsible}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.conversationId}>
                  <td>
                    <Link href={`/admin/clients/${item.client.id}`}>
                      {item.client.displayName ?? item.client.telegramId ?? CELL_TEXT.noName}
                    </Link>
                    {item.lastRequestDelivered ? null : (
                      // Обращение не дошло до оператора — это наша авария
                      // конфигурации, а клиент считает, что написал.
                      <div className="panel-error">{CELL_TEXT.notDeliveredToOperator}</div>
                    )}
                  </td>
                  <td>
                    <LocalAge iso={item.lastRequestAt.toISOString()} />
                  </td>
                  <td className={item.lastOperatorReplyAt ? 'panel-muted' : undefined}>
                    {item.lastOperatorReplyAt ? (
                      <LocalTime iso={item.lastOperatorReplyAt.toISOString()} />
                    ) : (
                      <span className="panel-status panel-status--warn">{CELL_TEXT.notAnswered}</span>
                    )}
                  </td>
                  <td>
                    {/* Режим — кто сейчас отвечает клиенту. Незнакомое значение
                        enum показываем как есть, а не прячем: это сигнал разъезда. */}
                    <span className={supportModeClass(item.handoffMode)}>
                      {lookupLabel(SUPPORT_MODE_LABELS, item.handoffMode) ?? item.handoffMode}
                    </span>
                  </td>
                  <td className="panel-muted">{item.assignedOperatorName ?? '—'}</td>
                  <td>
                    <Link href={`/admin/support/${item.conversationId}`}>{ACTION_TITLES.open}</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <PanelPager
        page={page}
        hasMore={hasMore}
        hrefFor={(next) => panelPageHref('/admin/support', {}, next)}
      />
    </PanelShell>
  );
}
