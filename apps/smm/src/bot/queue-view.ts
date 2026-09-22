import { buildCallback } from '../dialog/callback.ts';
import type { Keyboard } from '../dialog/types.ts';
import { TEXTS } from '../dialog/texts.ts';
import { IN_PROGRESS_STATUSES, type Store } from '../store/index.ts';
import type { Post } from '../store/types.ts';

/**
 * `/queue` — что начато и не вышло. Кнопки «Показать» и «Снять» у каждого
 * черновика: начатое иначе теряется между сессиями.
 */

const STATUS_LABELS: Record<string, string> = {
  draft: 'черновик',
  linted: 'прошёл линт',
  reviewed: 'проверен',
  previewed: 'показан',
  approved: 'ждёт выхода',
  handed: 'отдан в Threads',
};

export interface QueueItem {
  readonly post: Post;
  readonly line: string;
  readonly keyboard: Keyboard;
}

export function queueItems(store: Store, limit = 10): QueueItem[] {
  return store.posts
    .listByStatus(IN_PROGRESS_STATUSES, { limit })
    .map((post) => {
      const stamp = (post.textSha ?? post.id).slice(0, 8);
      const title = (post.body ?? post.sourceTitle ?? post.brief ?? 'без заголовка')
        .split('\n')[0]
        ?.replace(/^#\s*/, '')
        .slice(0, 60);
      return {
        post,
        line: `${STATUS_LABELS[post.status] ?? post.status}: ${title}`,
        keyboard: {
          rows: [
            [
              { text: 'Показать', data: buildCallback('show', post.id, stamp) },
              { text: TEXTS.buttons.drop, data: buildCallback('drop', post.id, stamp) },
            ],
          ],
        },
      };
    });
}

export function queueEmptyText(): string {
  return 'Черновиков нет.';
}
