import { describe, expect, it } from 'vitest';

import type { RubricKey } from '../config/smm.config.ts';
import { openStore, type Store } from '../store/index.ts';
import { buildReport, renderReport, REPORT_MAX_CHARS } from './report.ts';

const NOW = new Date('2026-09-22T10:00:00.000Z');

/** Опубликованный пост с рубрикой, рекламой и оценкой редактора. */
function publish(
  store: Store,
  options: {
    rubric: RubricKey;
    cta?: 'none' | 'soft' | 'hard';
    mean?: number;
    messageId: number;
    at: string;
  },
): string {
  const post = store.posts.create({ platform: 'telegram', rubric: options.rubric, layout: 'a' });
  store.posts.transition({ id: post.id, from: ['draft'], to: 'linted', decision: { kind: 'lint', actor: 'code' } });
  store.posts.patch(post.id, {
    body: '# Заголовок\n\nтело',
    cta: options.cta ?? 'none',
    ...(options.mean === undefined ? {} : { judge: { mean: options.mean, verdict: 'pass' } }),
  });
  store.posts.transition({ id: post.id, from: ['linted'], to: 'reviewed', decision: { kind: 'judge', actor: 'model' } });
  store.posts.transition({ id: post.id, from: ['reviewed'], to: 'previewed', decision: { kind: 'preview', actor: 'code' } });
  store.posts.transition({
    id: post.id,
    from: ['previewed'],
    to: 'approved',
    decision: { kind: 'approve', actor: 'owner', actorId: 1, textSha: store.posts.get(post.id)?.textSha ?? '' },
  });
  store.posts.transition({
    id: post.id,
    from: ['approved'],
    to: 'published',
    decision: { kind: 'publish', actor: 'code' },
    patch: { channelMessageId: options.messageId },
  });
  store.db.run('UPDATE posts SET published_at = ? WHERE id = ?', options.at, post.id);
  return post.id;
}

describe('отчёт', () => {
  it('на пустой базе говорит «постов пока нет» и не падает', () => {
    const store = openStore({ path: ':memory:' });
    const report = buildReport({ store, period: '30d', now: () => NOW });
    expect(report.empty).toBe(true);
    expect(renderReport(report)).toContain('Постов пока нет');
    store.close();
  });

  it('считает вышедшее, рубрики против плана и просмотры', () => {
    const store = openStore({ path: ':memory:' });
    const first = publish(store, { rubric: 'news', messageId: 10, at: '2026-09-20T10:00:00.000Z' });
    publish(store, { rubric: 'news', cta: 'soft', messageId: 11, at: '2026-09-21T10:00:00.000Z' });
    store.views.record(first, 1200);

    const report = buildReport({ store, period: '7d', subscribers: 480, now: () => NOW });
    const text = renderReport(report);

    expect(text).toContain('Подписчиков: 480');
    expect(text).toContain('Вышло за 7 дней: 2');
    expect(text).toContain('Что нового в ИИ: 2');
    expect(text).toContain('В среднем: 1200');
    expect(text).toContain('мягкое упоминание');
    store.close();
  });

  it('калибровка сравнивает оценки вышедших и снятых', () => {
    const store = openStore({ path: ':memory:' });
    publish(store, { rubric: 'news', mean: 4, messageId: 10, at: '2026-09-20T10:00:00.000Z' });
    const dropped = publish(store, { rubric: 'news', mean: 5, messageId: 11, at: '2026-09-21T10:00:00.000Z' });
    store.posts.transition({
      id: dropped,
      from: ['published'],
      to: 'withdrawn',
      decision: { kind: 'withdraw', actor: 'owner', actorId: 1 },
    });

    const text = renderReport(buildReport({ store, period: '30d', now: () => NOW }));
    expect(text).toContain('Средняя оценка вышедших: 4');
    expect(text).toContain('Средняя оценка снятых: 5');
    // Редактор хвалил то, что владелец убрал: об этом говорится прямо.
    expect(text).toContain('он хвалит не то');
    store.close();
  });

  it('расход на модель печатается в долларах по ролям', () => {
    const store = openStore({ path: ':memory:' });
    publish(store, { rubric: 'news', messageId: 10, at: '2026-09-20T10:00:00.000Z' });
    store.usage.add({
      role: 'write',
      model: 'deepseek-flash',
      inputTokens: 1000,
      outputTokens: 500,
      cacheHitTokens: 0,
      usdMicros: 12_340,
      isPeak: false,
      priceKnown: true,
    });

    const text = renderReport(buildReport({ store, period: '30d', now: () => NOW }));
    expect(text).toContain('$0.01');
    expect(text).toContain('write');
    store.close();
  });

  it('длинный отчёт режется секциями и говорит об этом', () => {
    const store = openStore({ path: ':memory:' });
    publish(store, { rubric: 'news', messageId: 10, at: '2026-09-20T10:00:00.000Z' });
    const report = buildReport({ store, period: '30d', now: () => NOW });

    const text = renderReport(report, 260);
    expect(text.length).toBeLessThanOrEqual(260);
    expect(text).toContain('не поместились');
    // Полный отчёт в лимит Telegram влезает сам.
    expect(renderReport(report).length).toBeLessThanOrEqual(REPORT_MAX_CHARS);
    store.close();
  });
});
