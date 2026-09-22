import type { Logger } from '../logger.ts';
import type { Store } from '../store/index.ts';

/**
 * Восстановление после перезапуска.
 *
 * Пост, застрявший в окне отмены, НЕ публикуется автоматически: таймер, который
 * видел клик, умер вместе с процессом, а решение публиковать принимает палец
 * владельца. Такой пост возвращается в превью, и владельцу говорят нажать
 * заново — это fail-closed, и это осознанно дороже, чем «дослать за него».
 */
export interface RecoveryResult {
  readonly returned: readonly string[];
  readonly message?: string;
}

export function recoverPendingPublishes(
  store: Store,
  logger: Logger,
  ownerId: number,
): RecoveryResult {
  const pending = store.posts.publishPending();
  const returned: string[] = [];

  for (const post of pending) {
    const result = store.posts.transition({
      id: post.id,
      from: ['approved'],
      to: 'previewed',
      decision: { kind: 'cancel', actor: 'code', payload: { reason: 'restart' } },
      patch: { publishAt: null },
    });
    if (result.ok) {
      returned.push(post.id);
      logger.warn({ postId: post.id }, 'перезапуск в окне отмены: публикация не состоялась');
    } else {
      logger.warn({ postId: post.id, actual: result.actual }, 'перезапуск: вернуть пост в превью не удалось');
    }
  }

  // Состояние диалога тоже чистится: иначе владелец жмёт «Отменить» у поста,
  // который уже вернулся в превью, и получает «кнопка устарела».
  const flow = store.flow.get(ownerId);
  if (flow?.state === 'post.publish_pending') store.flow.clear(ownerId);

  if (returned.length === 0) return { returned };
  return {
    returned,
    message:
      returned.length === 1
        ? 'Перезапуск внутри окна отмены: пост не вышел. Открой /queue и нажми «Опубликовать» ещё раз.'
        : `Перезапуск внутри окна отмены: ${returned.length} поста не вышли. Открой /queue и подтверди заново.`,
  };
}
