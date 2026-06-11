import { Fragment } from 'react';

/**
 * Лёгкий рендер текста агента: абзацы, списки (- / • / 1.), **bold**, автолинк.
 * НЕ полный markdown — без заголовков, таблиц, вложенности и raw HTML
 * (см. docs/web-design.md §ADR «plain text + лёгкое форматирование»).
 */

const TOKEN_SPLIT = /(\*\*[^*\n]+\*\*|https?:\/\/[^\s]+)/g;
const IS_URL = /^https?:\/\//;
const IS_BOLD = /^\*\*[^*\n]+\*\*$/;

const UL_LINE = /^[-•*]\s+(.+)$/;
const OL_LINE = /^(\d{1,2})[.)]\s+(.+)$/;

function Inline({ text }: { text: string }) {
  return (
    <>
      {text.split(TOKEN_SPLIT).map((part, i) => {
        if (IS_URL.test(part)) {
          return (
            <a
              key={i}
              href={part}
              target="_blank"
              rel="noopener noreferrer"
              className="break-all text-[var(--link)] underline"
            >
              {part}
            </a>
          );
        }
        if (IS_BOLD.test(part)) {
          return (
            <strong key={i} className="font-semibold">
              {part.slice(2, -2)}
            </strong>
          );
        }
        return <Fragment key={i}>{part}</Fragment>;
      })}
    </>
  );
}

type Block =
  | { kind: 'p'; lines: string[] }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; start: number; items: string[] };

function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let cur: Block | null = null;
  const flush = () => {
    if (cur) blocks.push(cur);
    cur = null;
  };

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    const ul = UL_LINE.exec(line);
    const ol = OL_LINE.exec(line);
    if (ul) {
      if (cur?.kind !== 'ul') {
        flush();
        cur = { kind: 'ul', items: [] };
      }
      cur.items.push(ul[1] ?? '');
    } else if (ol) {
      if (cur?.kind !== 'ol') {
        flush();
        cur = { kind: 'ol', start: Number(ol[1] ?? '1'), items: [] };
      }
      cur.items.push(ol[2] ?? '');
    } else {
      if (cur?.kind !== 'p') {
        flush();
        cur = { kind: 'p', lines: [] };
      }
      cur.lines.push(line);
    }
  }
  flush();
  return blocks;
}

export function RichText({ text }: { text: string }) {
  const blocks = parseBlocks(text);
  if (blocks.length === 0) return null;

  return (
    <div className="space-y-2.5 break-words">
      {blocks.map((b, i) => {
        if (b.kind === 'ul') {
          return (
            <ul key={i} className="list-disc space-y-1 pl-5 marker:text-[var(--accent)]">
              {b.items.map((item, j) => (
                <li key={j}>
                  <Inline text={item} />
                </li>
              ))}
            </ul>
          );
        }
        if (b.kind === 'ol') {
          return (
            <ol key={i} start={b.start} className="list-decimal space-y-1 pl-5 marker:font-semibold">
              {b.items.map((item, j) => (
                <li key={j}>
                  <Inline text={item} />
                </li>
              ))}
            </ol>
          );
        }
        return (
          <p key={i}>
            {b.lines.map((line, j) => (
              <Fragment key={j}>
                {j > 0 && <br />}
                <Inline text={line} />
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}
