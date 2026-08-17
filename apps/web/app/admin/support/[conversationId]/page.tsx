import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';

import { getDb, getSupportThreadForPanel } from '@oplati/db';

import { LocalTime } from '@/components/panel/LocalTime';
import { PanelForbidden, PanelShell } from '@/components/panel/PanelShell';
import { SupportReply } from '@/components/panel/SupportReply';
import { panelPageAccess } from '@/lib/panel/guard';
import {
  SUPPORT_BLOCK_TEXT,
  SUPPORT_HISTORY_DAYS,
  supportReplyBlockReason,
  supportRoleLabel,
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
        <PanelForbidden title="Обращение" />
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

  return (
    <PanelShell actor={access.actor}>
      <section className="panel-card" style={{ marginBottom: 16 }}>
        <h1 className="panel-title">
          <Link href={`/admin/clients/${thread.client.id}`}>
            {thread.client.displayName ?? thread.client.telegramId ?? 'Клиент без имени'}
          </Link>
        </h1>
        <p className="panel-muted">
          {thread.assignedOperatorName
            ? `Ведёт ${thread.assignedOperatorName}${mine ? ' (это ты)' : ''}`
            : 'Никто не ведёт диалог'}
          {' · '}
          <Link href="/admin/support">все обращения</Link>
        </p>
      </section>

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
          <p className="panel-empty">Сообщений нет.</p>
        ) : (
          <ol className="panel-thread">
            {thread.messages.map((message) => (
              <li key={message.id} className={`panel-thread__item panel-thread__item--${message.role}`}>
                <div className="panel-muted">
                  {supportRoleLabel(message.role, message.staffName)} ·{' '}
                  <LocalTime iso={message.createdAt.toISOString()} />
                </div>
                {/* Текст клиента печатается как есть: React экранирует его сам,
                    а разметку мы здесь не включаем намеренно. */}
                <div style={{ whiteSpace: 'pre-wrap' }}>{message.content}</div>
              </li>
            ))}
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
          />
        )}
      </section>
    </PanelShell>
  );
}
