import { describe, expect, it } from 'vitest';

import { openStore, StoreOpenError } from './index.ts';
import { sourceFiles } from '../testing/source-files.ts';

describe('канарейки хранилища', () => {
  it('статус поста меняет только transition', () => {
    // Инвариант «переходы — через одну функцию» (образец — transitionOrder в
    // проде). Прямой UPDATE обошёл бы и проверку разрешённых переходов, и
    // запись решения в журнал, то есть сломал бы гейт публикации.
    const offenders = sourceFiles()
      .filter((file) => file.path !== 'src/store/posts.ts')
      .filter((file) => /UPDATE\s+posts\s+SET[\s\S]{0,200}?\bstatus\s*=/i.test(file.code))
      .map((file) => file.path);
    expect(offenders).toEqual([]);
  });

  it('UPDATE статуса в posts.ts живёт ровно в одном месте', () => {
    const posts = sourceFiles().find((file) => file.path === 'src/store/posts.ts');
    expect(posts).toBeDefined();
    const matches = posts?.code.match(/UPDATE posts SET \$\{assignments\}/g) ?? [];
    // Два: один в patch (без статуса), один в transition (со статусом).
    expect(matches).toHaveLength(2);
    // В патче статуса нет — он собирается из закрытого списка колонок.
    expect(posts?.code).not.toMatch(/PATCH_COLUMNS[\s\S]{0,400}status:/);
  });

  it('SQL пишется только в store: остальной код ходит через репозитории', () => {
    const allowed = [/^src\/store\//, /^src\/stats\//];
    const offenders = sourceFiles()
      .filter((file) => /\b(SELECT|INSERT INTO|UPDATE|DELETE FROM)\s/i.test(file.code))
      .map((file) => file.path)
      .filter((path) => !allowed.some((rule) => rule.test(path)));
    expect(offenders).toEqual([]);
  });

  it('недоступный каталог базы даёт понятную ошибку, а не «ENOENT»', () => {
    // Прод-грабли: том смонтирован root-ом, процесс идёт под node — сообщение
    // обязано называть причину, иначе контейнер просто падает в цикле.
    expect(() => openStore({ path: '/dev/null/нельзя/smm.db' })).toThrowError(StoreOpenError);
    expect(() => openStore({ path: '/dev/null/нельзя/smm.db' })).toThrowError(/права|том/i);
  });
});
