import { describe, expect, it } from 'vitest';

import {
  IN_PROGRESS_STATUSES,
  POST_STATUSES,
  allowedTransitions,
  isTerminal,
  isTransitionAllowed,
} from './post-state.ts';

describe('машина статусов поста', () => {
  it('счастливый путь канала проходит целиком', () => {
    const path = ['draft', 'linted', 'reviewed', 'previewed', 'approved', 'published'] as const;
    for (let i = 0; i < path.length - 1; i += 1) {
      expect(isTransitionAllowed(path[i]!, path[i + 1]!), `${path[i]} → ${path[i + 1]}`).toBe(true);
    }
  });

  it('путь Threads: черновик, редактор, передан человеку, выложен', () => {
    expect(isTransitionAllowed('draft', 'linted')).toBe(true);
    expect(isTransitionAllowed('reviewed', 'handed')).toBe(true);
    expect(isTransitionAllowed('handed', 'posted')).toBe(true);
  });

  it('из любого неопубликованного статуса можно снять пост', () => {
    // «Снять» — это про то, что ещё не вышло. Вышедшее снимается иначе:
    // published и posted ведут только в withdrawn.
    const published: readonly string[] = ['published', 'posted'];
    for (const status of POST_STATUSES) {
      if (isTerminal(status) || published.includes(status)) continue;
      expect(isTransitionAllowed(status, 'rejected'), status).toBe(true);
    }
  });

  it('опубликованный пост нельзя снять как черновик — только withdrawn', () => {
    expect(allowedTransitions.published).toEqual(['withdrawn']);
    expect(isTransitionAllowed('published', 'rejected')).toBe(false);
    expect(isTransitionAllowed('published', 'draft')).toBe(false);
  });

  it('прыжок через превью запрещён: публикуется только увиденное', () => {
    // Гейт публикации держится на previewed_at того же text_sha, а машина
    // страхует его вторым слоем: из reviewed в published дороги нет.
    expect(isTransitionAllowed('reviewed', 'published')).toBe(false);
    expect(isTransitionAllowed('draft', 'published')).toBe(false);
    expect(isTransitionAllowed('previewed', 'published')).toBe(false);
  });

  it('отмена в окне возвращает пост из approved в previewed', () => {
    expect(isTransitionAllowed('approved', 'previewed')).toBe(true);
  });

  it('правки возвращают пост в черновик с любого шага до публикации', () => {
    expect(isTransitionAllowed('linted', 'draft')).toBe(true);
    expect(isTransitionAllowed('reviewed', 'draft')).toBe(true);
    expect(isTransitionAllowed('previewed', 'draft')).toBe(true);
    expect(isTransitionAllowed('handed', 'draft')).toBe(true);
  });

  it('повторный показ превью разрешён сам в себя', () => {
    // «Показать» в /queue пересылает превью заново и обновляет previewed_at.
    expect(isTransitionAllowed('previewed', 'previewed')).toBe(true);
  });

  it('терминальные статусы никуда не ведут, кроме снятия с витрины', () => {
    expect(allowedTransitions.rejected).toEqual([]);
    expect(allowedTransitions.withdrawn).toEqual([]);
    expect(allowedTransitions.posted).toEqual(['withdrawn']);
    expect(isTerminal('rejected')).toBe(true);
    expect(isTerminal('withdrawn')).toBe(true);
    expect(isTerminal('published')).toBe(false);
  });

  it('каждый статус описан в таблице переходов', () => {
    for (const status of POST_STATUSES) {
      expect(allowedTransitions[status], status).toBeDefined();
    }
    expect(Object.keys(allowedTransitions).sort()).toEqual([...POST_STATUSES].sort());
  });

  it('в таблице нет переходов в неизвестный статус', () => {
    for (const status of POST_STATUSES) {
      for (const target of allowedTransitions[status]) {
        expect(POST_STATUSES, `${status} → ${target}`).toContain(target);
      }
    }
  });

  it('статусы «в работе» — то, что показывает /queue', () => {
    // Список читает /queue: он показывает начатое, а не всё подряд. Готовый к
    // выходу пост (approved) там тоже нужен: он ждёт истечения окна отмены.
    expect([...IN_PROGRESS_STATUSES].sort()).toEqual(
      ['approved', 'draft', 'handed', 'linted', 'previewed', 'reviewed'].sort(),
    );
    for (const status of IN_PROGRESS_STATUSES) {
      expect(isTerminal(status), status).toBe(false);
    }
  });
});
