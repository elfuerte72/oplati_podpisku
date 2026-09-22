import { z } from 'zod';

import type { Logger } from '../logger.ts';
import type { Store } from '../store/index.ts';
import type { HealthStatus } from './check.ts';

/**
 * Сообщение о здоровье в тему «Ошибки» ops-группы.
 *
 * ⚠️ Пишет БОТ ВХОДА, а не бот канала: правило ops-группы прода — у всех
 * машинных сообщений один отправитель. Бот SMM в группу не пишет вовсе.
 *
 * Дедуп по НАБОРУ причин, а не по факту «красно»: пока ломается то же самое,
 * сообщение одно на шесть часов; сломалось новое — говорим сразу, иначе
 * вторая авария прячется за первой.
 */

export const HEALTH_DEDUP_HOURS = 6;
export const SETTINGS_HEALTH_LAST = 'health.lastAlert';

const LastAlertSchema = z.object({
  key: z.string(),
  at: z.string(),
});

export interface NotifyDeps {
  readonly store: Store;
  readonly logger: Logger;
  /**
   * Доставка в ops-группу. Тотальная: сбой доставки логируется адаптером и
   * наверх не бросается — сторож здоровья не должен падать из-за Telegram.
   */
  readonly send: (text: string, options: { toRoot?: boolean }) => Promise<{ ok: boolean; staleThread?: boolean }>;
  readonly now?: () => Date;
}

/** Ключ набора поломок: по нему считается «то же самое или новое». */
export function troubleKey(status: HealthStatus): string {
  return status.items
    .filter((item) => item.level === 'red')
    .map((item) => item.name)
    .sort()
    .join('|');
}

/**
 * Формат прода: маркер потока, заголовок, факты строками, «Что делать».
 * Тексты безличные — их читает дежурный, а не владелец канала.
 */
export function formatHealth(status: HealthStatus): string {
  const red = status.items.filter((item) => item.level === 'red');
  if (red.length === 0) {
    return ['[SMM] Снова зелено', '', 'Проверки здоровья проходят.'].join('\n');
  }
  return [
    '[SMM] Бот нездоров',
    '',
    ...red.map((item) => `${item.name}: ${item.reason}`),
    '',
    'Что делать: проверить названные пункты. Бот продолжает принимать команды,',
    'но конвейер поста может не работать.',
  ].join('\n');
}

export async function notifyIfRed(status: HealthStatus, deps: NotifyDeps): Promise<'sent' | 'recovered' | 'muted'> {
  const now = deps.now ?? ((): Date => new Date());
  const at = now();
  const last = deps.store.settings.get(SETTINGS_HEALTH_LAST, LastAlertSchema);

  async function deliver(text: string): Promise<void> {
    const first = await deps.send(text, {});
    if (first.ok) return;
    if (first.staleThread === true) {
      // Тема протухла (её удалили или закрыли) — повторяем в корень группы:
      // сообщение о поломке важнее места, куда оно попадёт.
      const again = await deps.send(text, { toRoot: true });
      if (again.ok) return;
    }
    deps.logger.warn({}, 'сообщение о здоровье не доставлено');
  }

  if (status.level === 'green') {
    if (last === undefined) return 'muted';
    // Одно «снова зелено» на выздоровление: запись стирается, и следующая
    // поломка снова будет первой.
    deps.store.settings.remove(SETTINGS_HEALTH_LAST);
    await deliver(formatHealth(status));
    return 'recovered';
  }

  const key = troubleKey(status);
  if (last !== undefined && last.key === key) {
    const passed = at.getTime() - new Date(last.at).getTime();
    if (Number.isFinite(passed) && passed < HEALTH_DEDUP_HOURS * 60 * 60 * 1000) return 'muted';
  }

  deps.store.settings.set(SETTINGS_HEALTH_LAST, LastAlertSchema, { key, at: at.toISOString() });
  await deliver(formatHealth(status));
  return 'sent';
}
