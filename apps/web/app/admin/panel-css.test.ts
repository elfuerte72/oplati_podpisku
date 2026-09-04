import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Канарейки файла стилей панели (вариант A дизайн-аудита, тикеты 01–02).
 *
 * ⚠️ Честно: это проверки РЕАЛИЗАЦИИ, а не поведения, и заведены они
 * сознательно — оба дефекта, которые они ловят, в проде НЕ ПАДАЮТ ВООБЩЕ.
 *
 *   - Класс, стоящий в разметке и не описанный в стилях, браузер игнорирует
 *     молча. `panel-button--secondary` полтора месяца стоял на пяти кнопках и
 *     рисовался ровно как основное действие: «Закрыть» выглядела как
 *     «Отправить». Ни сборка, ни тесты, ни ревью этого не видели.
 *   - Цвет, заданный мимо токена темы, тоже не падает: он просто не меняется
 *     при смене темы. Так три цвета ролей в переписке в светлой теме
 *     оставались тёмными.
 *
 * Прецедент в репозитории есть: канарейки словаря (`lib/panel/labels.test.ts`)
 * и денилиста поддержки устроены так же.
 */

const here = fileURLToPath(new URL('.', import.meta.url));
const web = join(here, '..', '..');
const cssPath = join(here, 'panel.css');

/** Комментарии выкидываем: расчёты контраста рядом со значениями — текст. */
function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/** Разметка панели: страницы раздела и её компоненты. */
function markupFiles(): string[] {
  return [...walk(join(web, 'app', 'admin')), ...walk(join(web, 'components', 'panel'))].filter(
    (file) => file.endsWith('.tsx'),
  );
}

const css = withoutComments(readFileSync(cssPath, 'utf8'));

describe('цвет приходит только из токена темы', () => {
  /**
   * Литеральный цвет: hex, `rgb()/rgba()`, `hsl()/hsla()`. Ключевые слова
   * `transparent`, `currentColor` и `inherit` цветом темы не являются — они
   * означают «взять у родителя» и разъехаться не могут.
   */
  const LITERAL_COLOR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\s*\(/;

  it('регэксп ловит зашитый цвет — иначе канарейка не умеет падать', () => {
    expect(LITERAL_COLOR.test('  border-left-color: #4c8bf5;')).toBe(true);
    expect(LITERAL_COLOR.test('  background: rgba(0, 0, 0, 0.5);')).toBe(true);
    expect(LITERAL_COLOR.test('  background: var(--panel-scrim);')).toBe(false);
    expect(LITERAL_COLOR.test('  fill: transparent;')).toBe(false);
  });

  it('литеральный цвет встречается ТОЛЬКО в объявлении токена', () => {
    const offenders = css
      .split('\n')
      .map((line, index) => ({ line: line.trim(), number: index + 1 }))
      // Объявление токена (`--panel-bg: #f5f5f7;`) — единственное место, где
      // значение цвета и записывается: там оно и должно жить.
      .filter(({ line }) => !line.startsWith('--panel-'))
      .filter(({ line }) => LITERAL_COLOR.test(line))
      .map(({ line, number }) => `panel.css:${number}: ${line}`);

    expect(offenders).toEqual([]);
  });

  it('обе темы объявляют ОДИН набор токенов', () => {
    // Забытый в одной теме токен не падает: он тихо оставляет значение
    // соседней темы — в тёмной панели остаётся светлая рамка.
    const base = [...declaredTokens('.panel {').keys()];
    const dark = [...declaredTokens('.panel[data-panel-theme="dark"] {').keys()];

    expect(base.length).toBeGreaterThan(20);
    // Тёмная переопределяет цвета; размеры, шрифты и радиусы у тем общие,
    // поэтому проверяем ВКЛЮЧЕНИЕ, а не равенство наборов.
    expect(dark.filter((token) => !base.includes(token))).toEqual([]);
  });

  it('оба входа в тёмную тему объявляют одно и то же', () => {
    // Тёмная тема включается ДВУМЯ путями: выбором сотрудника и настройкой
    // системы при умолчании «как в системе». Одним селектором это не выразить
    // (медиазапрос в списке селекторов не живёт), поэтому набор дублируется —
    // и это единственное зеркало в файле. Разъезд не падает и не виден:
    // сотрудник, не трогавший тумблер, просто получал бы другую панель.
    const chosen = declaredTokens('.panel[data-panel-theme="dark"] {');
    const bySystem = declaredTokens('.panel[data-panel-theme="system"] {');

    expect(bySystem.size).toBeGreaterThan(15);
    expect([...bySystem.entries()]).toEqual(
      [...chosen.entries()].filter(([name]) => bySystem.has(name)),
    );
    expect([...chosen.keys()].filter((name) => !bySystem.has(name))).toEqual([]);
  });
});

/** Токены (имя → значение), объявленные внутри блока `selector`. */
function declaredTokens(selector: string): Map<string, string> {
  const start = css.indexOf(selector);
  expect(start, `в panel.css нет блока ${selector}`).toBeGreaterThanOrEqual(0);
  const end = css.indexOf('\n}', start);
  const body = css.slice(start, end);
  return new Map(
    [...body.matchAll(/^\s*(--panel-[a-z0-9-]+)\s*:\s*([^;]+);/gm)].map((match) => [
      match[1] ?? '',
      (match[2] ?? '').replace(/\s+/g, ' ').trim(),
    ]),
  );
}

describe('иерархия набирается весом, а не начертанием', () => {
  it('жирнее полужирного в панели не бывает', () => {
    // Правило типографики варианта A: 400 текст, 500 кнопки и активный пункт
    // меню, 600 заголовки. 700 читается как второй акцент на экране, где
    // акцент должен быть один.
    const offenders = css
      .split('\n')
      .map((line, index) => ({ line: line.trim(), number: index + 1 }))
      .filter(({ line }) => /font-weight\s*:\s*(700|800|900|bold(er)?)\b/.test(line))
      .map(({ line, number }) => `panel.css:${number}: ${line}`);

    expect(offenders).toEqual([]);
  });
});

describe('классы разметки описаны в стилях', () => {
  /**
   * Имя класса панели: `panel-…`, строчные буквы, цифры и дефисы. Из строк
   * разметки берутся ВСЕ такие слова — в панели `panel-` носят только классы.
   */
  const CLASS_TOKEN = /^panel-[a-z0-9-]+$/;

  /**
   * Значение атрибута `className` — и только его: на одной строке с классом
   * живёт `id="panel-menu"`, а требовать для идентификатора правило в стилях
   * бессмысленно. Фигурные скобки считаются по глубине: `${…}` внутри
   * шаблонной строки добавляет свою пару, и обрыв по первой закрывающей
   * потерял бы хвост выражения.
   */
  function classNameValues(source: string): string[] {
    const values: string[] = [];
    const attribute = /className=\s*/g;
    for (let hit = attribute.exec(source); hit; hit = attribute.exec(source)) {
      let index = hit.index + hit[0].length;
      const opener = source[index];
      if (opener === '"' || opener === "'") {
        const end = source.indexOf(opener, index + 1);
        if (end < 0) continue;
        values.push(source.slice(index + 1, end));
        continue;
      }
      if (opener !== '{') continue;
      let depth = 0;
      const start = index;
      for (; index < source.length; index += 1) {
        if (source[index] === '{') depth += 1;
        else if (source[index] === '}') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      values.push(source.slice(start, index));
    }
    return values;
  }

  /** Строковые литералы фрагмента — без содержимого подстановок. */
  function stringLiterals(fragment: string): string[] {
    return [
      ...fragment.replace(/\$\{[^}]*\}/g, ' ').matchAll(/'([^']*)'|"([^"]*)"|`([^`]*)`/g),
    ].map((match) => match[1] ?? match[2] ?? match[3] ?? '');
  }

  function classNamesIn(source: string): string[] {
    return classNameValues(source)
      .flatMap((value) => (value.startsWith('{') ? stringLiterals(value) : [value]))
      .flatMap((value) => value.split(/\s+/))
      .filter((token) => CLASS_TOKEN.test(token));
  }

  /**
   * Классы, собранные закрытым словарём, в разметке не встречаются вовсе —
   * проверяем их прямо в модуле, иначе `panel-status--mode-ai` снова стал бы
   * невидимым для канарейки.
   */
  function classNamesInDictionary(): string[] {
    // Комментарии выкидываем: в них имена классов упоминаются как примеры,
    // в том числе те самые «собранные подстановкой», ради которых модуль и
    // заведён.
    const source = readFileSync(join(web, 'lib', 'panel', 'class-names.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/.*$/gm, '');
    return stringLiterals(source)
      .flatMap((value) => value.split(/\s+/))
      .filter((token) => CLASS_TOKEN.test(token));
  }

  const described = new Set(
    [...css.matchAll(/\.(panel-[a-z0-9-]+)/g)].map((match) => match[1] ?? ''),
  );

  it('канарейка умеет падать: выдуманный класс в описанных не значится', () => {
    expect(described.has('panel-button')).toBe(true);
    expect(described.has('panel-button--invented')).toBe(false);
    expect(classNamesIn('className="panel-card panel-wrap"')).toEqual([
      'panel-card',
      'panel-wrap',
    ]);
  });

  it('каждый класс панели из разметки описан в panel.css', () => {
    const files = markupFiles();
    expect(files.length).toBeGreaterThan(10);

    const offenders: string[] = [];
    for (const file of files) {
      for (const name of classNamesIn(readFileSync(file, 'utf8'))) {
        if (!described.has(name)) offenders.push(`${file.slice(web.length + 1)}: ${name}`);
      }
    }
    for (const name of classNamesInDictionary()) {
      if (!described.has(name)) offenders.push(`lib/panel/class-names.ts: ${name}`);
    }

    expect([...new Set(offenders)]).toEqual([]);
  });

  it('класс не собирается подстановкой — иначе его не с чем сверить', () => {
    // `panel-status--mode-${mode}` канарейке невидим: она проверяет строки, а
    // не значения. Поэтому варианты перечисляются закрытым словарём
    // (`lib/panel/class-names.ts`), и в разметку попадает готовое имя.
    const offenders: string[] = [];
    for (const file of markupFiles()) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/panel-[a-z0-9-]*\$\{/g)) {
        offenders.push(`${file.slice(web.length + 1)}: ${match[0]}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
