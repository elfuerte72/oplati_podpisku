import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';

import { getDb, getSupportThreadForPanel, listSupportRequestsForPanel } from '@oplati/db';

import { LocalTime } from '@/components/panel/LocalTime';
import { PanelPageHeader } from '@/components/panel/PanelPageHeader';
import { PanelForbidden, PanelShell } from '@/components/panel/PanelShell';
import { SupportMarkAnswered } from '@/components/panel/SupportMarkAnswered';
import { SupportReply } from '@/components/panel/SupportReply';
import { threadItemClass } from '@/lib/panel/class-names';
import { panelPageAccess } from '@/lib/panel/guard';
import {
  ACTION_TITLES,
  CELL_TEXT,
  COLUMN_TITLES,
  PAGE_TITLES,
  SUPPORT_BLOCK_TEXT,
  SUPPORT_MARK_ANSWERED_HINT,
  SUPPORT_MODE_LABELS,
} from '@/lib/panel/labels';
import { lookupLabel } from '@/lib/panel/format';
import { SUPPORT_HISTORY_DAYS, supportReplyBlockReason, supportRoleLabel, supportStateNote } from '@/lib/panel/support';
import { effectiveSupportMode } from '@/lib/panel/support-mode';
import { canReturnToAi } from '@/lib/panel/permissions';
import { isSupportAiAvailable } from '@/lib/support/availability';

/**
 * `/admin/support/<conversationId>` — переписка и ответ клиенту (спека §5.6).
 *
 * ⚠️ Два РАЗНЫХ ограничения ленты, и путать их нельзя: усечение по потолку
 * выборки («сообщений больше, чем помещается») и ретеншен («старше срока
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

  const db = getDb();
  const thread = await getSupportThreadForPanel(db, parsed.data);
  if (!thread) notFound();

  // «Ждёт человека» — флагом СПИСКА, а не своим выводом из режима: правило
  // одно на список, счётчик, сторожа крона и операцию отметки, и кнопка
  // «Отвечено» обязана появляться ровно там, где операция её примет.
  const { items: clientRequests } = await listSupportRequestsForPanel(db, {
    userId: thread.client.id,
  });
  const awaitingOperator =
    clientRequests.find((r) => r.conversationId === thread.conversationId)?.awaitingOperator ?? false;

  const blocked = supportReplyBlockReason({
    clientTelegramId: thread.client.telegramId,
    assignedOperatorId: thread.assignedOperatorId,
    actorId: access.actor.id,
  });
  const mine = thread.assignedOperatorId === access.actor.id;
  // Эффективный режим: сессия помощника гаснет лениво, и истёкшая в БД всё ещё
  // `ai` (SUP-13). Кнопки ниже решают по записанному режиму — операции тоже
  // проверяют его, а не экранный.
  const shownMode = effectiveSupportMode(thread.handoffMode, thread.modeExpiresAt);
  const modeLabel = lookupLabel(SUPPORT_MODE_LABELS, shownMode) ?? shownMode;
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
                  <li key={message.id} className={`${threadItemClass('system')} panel-muted`}>
                    {note} · <LocalTime iso={message.createdAt.toISOString()} />
                  </li>
                );
              }
              return (
                <li key={message.id} className={threadItemClass(message.role)}>
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
        {blocked ? <p className="panel-muted">{SUPPORT_BLOCK_TEXT[blocked]}</p> : null}
        {/* Поле ответа закрыто чужим захватом или отсутствием Telegram, но
            «Вернуть помощнику» (админу) и «Закрыть» операции разрешают — без
            кнопок админ не мог бы отпустить разговор ушедшего в отпуск коллеги. */}
        {!blocked || mayReturn || inOperatorMode ? (
          <SupportReply
            conversationId={thread.conversationId}
            needsAssign={thread.assignedOperatorId === null}
            canReply={!blocked}
            canReturn={mayReturn}
            canClose={inOperatorMode}
            assistantAvailable={isSupportAiAvailable()}
          />
        ) : null}
        {/* ⚠️ Вне условия выше намеренно: клиенту без Telegram из панели не
            ответить вовсе, и отметка — единственный способ снять его обращение. */}
        {awaitingOperator ? (
          <div style={{ marginTop: 12 }}>
            <p className="panel-muted" style={{ marginBottom: 8 }}>
              {SUPPORT_MARK_ANSWERED_HINT}
            </p>
            <SupportMarkAnswered conversationId={thread.conversationId} />
          </div>
        ) : null}
      </section>
    </PanelShell>
  );
}
