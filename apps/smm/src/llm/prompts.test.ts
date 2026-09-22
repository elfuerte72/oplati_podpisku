import { describe, expect, it } from 'vitest';

import { MODEL_ROLES, smmConfig } from '../config/smm.config.ts';
import { loadPrompts } from './prompts.ts';

describe('промпты ролей', () => {
  const set = loadPrompts();

  it('файл есть у каждой роли и он не пустой', () => {
    // Недостающий файл обязан ронять процесс при старте, а не на первом посте.
    for (const role of MODEL_ROLES) {
      expect(set[role].length, role).toBeGreaterThan(200);
    }
  });

  it('фрагмент о голосе подставлен, а маркер не остался в тексте', () => {
    for (const role of MODEL_ROLES) {
      expect(set[role], role).not.toContain('{{voice}}');
    }
    // Голос нужен тем, кто пишет; судье и ранжированию он не нужен.
    expect(set.write).toContain('Читатель');
    expect(set.revise).toContain('Читатель');
    expect(set.threads).toContain('Читатель');
    expect(set.plan).toContain('Читатель');
  });

  it('роли, отдающие JSON, просят JSON и дают пример формы', () => {
    for (const role of ['dossier', 'plan', 'judge', 'rank', 'threads'] as const) {
      expect(set[role], role).toMatch(/JSON/);
      expect(set[role], role).toMatch(/Пример формы ответа/);
    }
  });

  it('роли, отдающие текст, просят только текст', () => {
    expect(set.write).toMatch(/ТОЛЬКО текстом поста/);
    expect(set.revise).toMatch(/ТОЛЬКО полным текстом поста/);
  });

  it('в промптах нет чисел, которыми владеет конфиг', () => {
    // Зеркало «потолок в промпте и порог в коде» разъезжается молча: длины,
    // пороги судьи и лимиты Threads приходят в ЗАПРОСЕ из конфига.
    const numeric = /\b(350|280|600|480|1024|4096|32768|700|1500|1200)\b/;
    for (const role of MODEL_ROLES) {
      expect(set[role], role).not.toMatch(numeric);
    }
  });

  it('промпт судьи не перечисляет критерии: они приходят из конфига', () => {
    // Второй список критериев рядом со схемой означал бы, что судья оценивает
    // одно, а код считает другое.
    for (const criterion of smmConfig.judge.telegram.criteria) {
      if (criterion.key === 'facts' || criterion.key === 'texture') continue;
      expect(set.judge, criterion.key).not.toContain(criterion.description.slice(0, 40));
    }
    expect(set.judge).toMatch(/критерии из запроса/i);
  });

  it('промпт судьи требует цитату под каждой претензией', () => {
    expect(set.judge).toMatch(/ЦИТАТУ/);
  });

  it('красные линии названы в фрагменте о голосе', () => {
    expect(set.write).toMatch(/страна выпуска карты/);
    expect(set.write).toMatch(/выдуманные цифры/);
  });

  it('эмодзи в промптах нет', () => {
    const emoji = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
    for (const role of MODEL_ROLES) {
      expect(set[role], role).not.toMatch(emoji);
    }
  });
});
