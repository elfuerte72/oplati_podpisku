import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';

import { getDb, getSupportThreadForPanel } from '@oplati/db';

import { LocalTime } from '@/components/panel/LocalTime';
import { PanelPageHeader } from '@/components/panel/PanelPageHeader';
import { PanelForbidden, PanelShell } from '@/components/panel/PanelShell';
import { SupportReply } from '@/components/panel/SupportReply';
import { panelPageAccess } from '@/lib/panel/guard';
import {
  ACTION_TITLES,
  CELL_TEXT,
  COLUMN_TITLES,
  PAGE_TITLES,
  SUPPORT_BLOCK_TEXT,
  SUPPORT_MODE_LABELS,
} from '@/lib/panel/labels';
import { lookupLabel } from '@/lib/panel/format';
import {
  SUPPORT_HISTORY_DAYS,
  canReturnToAi,
  supportReplyBlockReason,
  supportRoleLabel,
  supportStateNote,
} from '@/lib/panel/support';

/**
 * `/admin/support/<conversationId>` — переписка и ответ клиенту (спека §5.6).
 *
 * ⚠️ Два РАЗНЫХ ограничения ленты, и путать их нельзя: усечение по потолку
 * выборки («сообщений больше, чем помещается») и ретеншен («старше 90 дней
 * удаляются»). Первое — про экран, второе — про данные; сказать «начало не
 * сохранилось» при длинной свежей переписке значит соврать.
 *
 * ⚠️ Клиенту без Telegram поле ответа не рисуется: он писал с сайта, и
 * обратного адреса у нас нет.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: PAGE_TITLES.request };

const idSchema = z.string().uuid();

export default async function PanelSupportThreadPage({
  params,
}: {
  params: Promise<{ conversationId: string }>;
}) {
  const access = await panelPageAccess('support');
  if (!access.allowed) {
    return (
      <PanelShell actor={access.actor} live={false}>
        <PanelForbidden title={PAGE_TITLES.request} />
      </PanelShell>
    );
  }

  const { conversationId } = await params;
  const parsed = idSchema.safeParse(conversationId);
  if (!parsed.success) notFound();

  const thread = await getSupportThreadForPanel(getDb(), parsed.data);
  if (!thread) notFound();

  const blocked = supportReplyBlockReason({
    clientTelegramId: thread.client.telegramId,
    assignedOperatorId: thread.assignedOperatorId,
    actorId: access.actor.id,
  });
  const mine = thread.assignedOperatorId === access.actor.id;
  const modeLabel = lookupLabel(SUPPORT_MODE_LABELS, thread.handoffMode) ?? thread.handoffMode;
  const inOperatorMode = thread.handoffMode === 'operator';
  const mayReturn =
    inOperatorMode &&
    canReturnToAi({
      actorId: access.actor.id,
      actorRole: access.actor.role,
      assignedOperatorId: thread.assignedOperatorId,
    });

  return (
    <PanelShell actor={access.actor}>
      <PanelPageHeader
        title={
          <Link href={`/admin/clients/${thread.client.id}`}>
            {thread.client.displayName ?? thread.client.telegramId ?? CELL_TEXT.clientNoName}
          </Link>
        }
      >
        <p className="panel-muted">
          {COLUMN_TITLES.mode}: {modeLabel}
          {' · '}
          {thread.assignedOperatorName
            ? `${COLUMN_TITLES.responsible}: ${thread.assignedOperatorName}${mine ? ' (вы)' : ''}`
            : 'Ответственного нет'}
          {' · '}
          <Link href="/admin/support">{ACTION_TITLES.allRequests}</Link>
        </p>
      </PanelPageHeader>

      <section className="panel-card" style={{ marginBottom: 16 }}>
        <h2 className="panel-title">Переписка</h2>
        {thread.hasMore ? (
          // Усечение по потолку выборки — это НЕ ретеншен. Утверждать про
          // удаление данных там, где клиент просто написал шестьдесят
          // сообщений сегодня, значит сказать неправду.
          <p className="panel-muted">Показан конец переписки: сообщений больше, чем помещается.</p>
        ) : null}
        <p className="panel-muted">
          Переписка старше {SUPPORT_HISTORY_DAYS} дней удаляется автоматически — если начало
          обрывается, это не потеря данных.
        </p>

        {thread.messages.length === 0 ? (
          <p className="panel-empty">{CELL_TEXT.noMessages}</p>
        ) : (
          <ol className="panel-thread">
            {thread.messages.map((message) => {
              // Служебная строка перехода режима — серая одна строка с
              // триггером и причиной, а не реплика. Клиенту она не уходила.
              const note = supportStateNote(message.meta);
              if (note) {
                return (
                  <li key={message.id} className="panel-thread__item panel-thread__item--system panel-muted">
                    {note} · <LocalTime iso={message.createdAt.toISOString()} />
                  </li>
                );
              }
              return (
                <li key={message.id} className={`panel-thread__item panel-thread__item--${message.role}`}>
                  <div className="panel-muted">
                    {supportRoleLabel(message.role, message.staffName, message.meta)} ·{' '}
                    <LocalTime iso={message.createdAt.toISOString()} />
                  </div>
                  {/* Текст клиента печатается как есть: React экранирует его сам,
                      а разметку мы здесь не включаем намеренно. */}
                  <div style={{ whiteSpace: 'pre-wrap' }}>{message.content}</div>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <section className="panel-card">
        <h2 className="panel-title">Ответить</h2>
        {blocked ? (
          <p className="panel-muted">{SUPPORT_BLOCK_TEXT[blocked]}</p>
        ) : (
          <SupportReply
            conversationId={thread.conversationId}
            needsAssign={thread.assignedOperatorId === null}
            canReturn={mayReturn}
            canClose={inOperatorMode}
          />
        )}
      </section>
    </PanelShell>
  );
}
