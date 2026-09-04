import 'server-only';

import * as Sentry from '@sentry/nextjs';

import { notifyStaff } from '@/lib/alerts/notify-staff';
import { childLogger } from '@/lib/logger';

/**
 * Доставка обращений клиентов персоналу. Общий модуль для бота (/support),
 * личного кабинета («Не проходит оплата?» из Mini App) и помощника поддержки
 * (эскалация).
 *
 * Канал ОДИН — `notifyStaff` с капабилити `support` (бот входа): при заданной
 * ops-группе это пост в тему «Поддержка», без группы — личка каждому
 * сотруднику с правом на раздел. Резервный путь через КЛИЕНТСКОГО бота
 * (`SUPPORT_OPERATOR_CHAT_ID`) удалён треком ops-group (тикет 03): у
 * клиентского бота ровно одна роль — клиенты, операторам он не пишет.
 */

const log = childLogger('telegram.support');

/**
 * Шлёт готовый HTML персоналу. Возвращает `false` при сбое (никого нет в
 * `staff`, все дали 403, бот входа не настроен), чтобы caller честно сообщил
 * пользователю: это единственный канал связи с клиентом, и «передали»
 * при недоставленном обращении было бы ложью.
 *
 * Текст HTML-ный (клиентский бот собирает его с `parse_mode`), а бот входа
 * шлёт простым текстом — теги снимаем, а не оставляем человеку в виде
 * `&lt;b&gt;`.
 */
export async function sendToSupportOperator(
  operatorMessage: string,
  logCtx: Record<string, unknown> = {},
): Promise<boolean> {
  try {
    // ⚠️ Без фолбэка владельцу через `notifyOps`: результат «доставлено»
    // там равен нулю даже при состоявшейся доставке, и клиент получал бы
    // «не получилось» при живом сообщении у владельца. Пустой штат — авария
    // конфигурации, о ней ниже отдельно.
    // Заголовок не добавляем: у обращения он свой (собран вместе с текстом
    // клиента), а хвост «Что делать» ведёт в раздел поддержки.
    const res = await notifyStaff(stripHtmlTags(operatorMessage), {
      capability: 'support',
      fallbackToOps: false,
      action: { text: 'ответить клиенту', path: '/admin/support' },
    });
    if (res.delivered > 0) {
      log.info({ event: 'telegram.support.notified', delivered: res.delivered, ...logCtx });
      return true;
    }
    // Обращение клиента некому доставить — конфигурационная авария, не
    // штатный кейс: шумим в лог и Sentry, caller честно скажет клиенту.
    log.error({ event: 'telegram.support.not_delivered', failed: res.failed, ...logCtx });
    Sentry.captureMessage('Обращение в поддержку не доставлено — нет получателей', {
      level: 'error',
      tags: { source: 'telegram.support' },
      extra: { failed: res.failed },
    });
    return false;
  } catch (err) {
    // `notifyStaff` по контракту не бросает; страховка на случай, если это
    // изменится, — обращение всё равно не должно ронять вызывающего.
    log.error({ event: 'telegram.support.staff_notify_failed', ...logCtx, err });
    Sentry.captureException(err, { tags: { source: 'telegram.support' } });
    return false;
  }
}

/**
 * Снятие разметки для бота персонала: обращение собирается как HTML (клиентский
 * бот шлёт с `parse_mode`), а бот входа отправляет простым текстом.
 *
 * ⚠️ Ссылка не выбрасывается, а РАСКРЫВАЕТСЯ: `<a href="tg://user?id=1">чат</a>`
 * → `чат (tg://user?id=1)`. Слепое удаление тегов оставляло менеджеру мёртвый
 * текст «Профиль: открыть чат», то есть превращало в ничто ровно ту кнопку,
 * ради которой строка и существует.
 *
 * ⚠️ Сущности раскодируются ПОСЛЕ снятия тегов. Обратный порядок превратил бы
 * экранированный текст клиента (`&lt;b&gt;`) в разметку и съел бы её.
 */
export function stripHtmlTags(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
