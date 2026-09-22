import { describe, expect, it } from 'vitest';

import { openStore, StoreOpenError } from './index.ts';
import { codeWithoutComments, sourceFiles } from '../testing/source-files.ts';

/**
 * Проверка «статус двигает только transition» ищет ЛЮБУЮ запись в `posts`, а не
 * конкретную текстовую форму. Первая версия правила искала
 * `UPDATE posts SET … status =` и обходилась восемью способами:
 * `UPDATE posts AS p`, `UPDATE "posts"`, `UPDATE main.posts`,
 * `INSERT … ON CONFLICT DO UPDATE`, `INSERT OR REPLACE`, имя колонки
 * подстановкой, статус дальше двухсот знаков от `SET`.
 */
const WRITES_TO_POSTS = [
  /UPDATE\s+(?:OR\s+\w+\s+)?(?:main\.)?["'`[]?posts\b/i,
  /INSERT\s+(?:OR\s+\w+\s+)?INTO\s+(?:main\.)?["'`[]?posts\b/i,
  /DELETE\s+FROM\s+(?:main\.)?["'`[]?posts\b/i,
];

describe('канарейки хранилища', () => {
  it('в posts пишет только src/store/posts.ts', () => {
    const offenders = sourceFiles()
      .filter((file) => file.path !== 'src/store/posts.ts')
      .filter((file) => WRITES_TO_POSTS.some((rule) => rule.test(codeWithoutComments(file.code))))
      .map((file) => file.path);
    expect(offenders).toEqual([]);
  });

  it('канарейка ловит все известные формы обхода', () => {
    // Молчащая проверка хуже отсутствия: правило проверяется образцами.
    const samples = [
      "db.run(`UPDATE posts SET status = ? WHERE id = ?`, 'published', id)",
      'db.run(`UPDATE posts AS p SET status = ?`, s)',
      'db.run(`UPDATE "posts" SET status = ?`, s)',
      'db.run(`UPDATE main.posts SET status = ?`, s)',
      'db.run(`UPDATE OR REPLACE posts SET status = ?`, s)',
      'db.run(`INSERT INTO posts (id, status) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET status = ?`)',
      'db.run(`INSERT OR REPLACE INTO posts (id, status) VALUES (?, ?)`)',
      'db.run(`DELETE FROM posts WHERE id = ?`, id)',
      // Имя колонки подстановкой: форма «UPDATE posts» всё равно видна.
      'db.run(`UPDATE posts SET ${column} = ?`, value)',
    ];
    for (const sample of samples) {
      expect(
        WRITES_TO_POSTS.some((rule) => rule.test(sample)),
        sample,
      ).toBe(true);
    }
  });

  it('UPDATE в posts.ts живёт в трёх известных местах', () => {
    const posts = sourceFiles().find((file) => file.path === 'src/store/posts.ts');
    expect(posts).toBeDefined();
    const updates = posts?.code.match(/UPDATE posts SET/g) ?? [];
    // patch (без статуса), transition (со статусом) и запись
    // previewed_decision_id после показа превью.
    expect(updates).toHaveLength(3);
    // В патче статуса нет: список колонок закрыт.
    expect(posts?.code).not.toMatch(/PATCH_COLUMNS[\s\S]{0,600}status:/);
  });

  it('SQL пишется только в src/store: остальной код ходит через репозитории', () => {
    const offenders = sourceFiles()
      .filter((file) => /\b(SELECT|INSERT INTO|UPDATE|DELETE FROM)\s/i.test(codeWithoutComments(file.code)))
      .map((file) => file.path)
      .filter((path) => !/^src\/store\//.test(path));
    expect(offenders).toEqual([]);
  });

  it('отпечаток текста считает только store', () => {
    // Отпечаток — производное тела. Второе место, где он считается, вернуло бы
    // возможность подтвердить один текст, а опубликовать другой.
    const offenders = sourceFiles()
      .filter((file) => file.path !== 'src/store/text-sha.ts')
      .filter((file) => /createHash\(\s*['"]sha256/.test(file.code))
      .map((file) => file.path);
    expect(offenders).toEqual([]);
  });

  it('node:sqlite знает только db.ts', () => {
    const offenders = sourceFiles()
      .filter((file) => file.path !== 'src/store/db.ts')
      .filter((file) => file.code.includes('node:sqlite'))
      .map((file) => file.path);
    expect(offenders).toEqual([]);
  });

  it('недоступный каталог базы даёт понятную ошибку, а не «ENOENT»', () => {
    // Прод-грабли: том смонтирован root-ом, процесс идёт под node — сообщение
    // обязано называть причину, иначе контейнер просто падает в цикле.
    expect(() => openStore({ path: '/dev/null/нельзя/smm.db' })).toThrowError(StoreOpenError);
    expect(() => openStore({ path: '/dev/null/нельзя/smm.db' })).toThrowError(/права|том/i);
  });
});
