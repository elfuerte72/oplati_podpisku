import { type AlertStream, STREAM_MARKERS } from './kinds.ts';

/**
 * Единый шаблон уведомления персоналу и владельцу (трек ops-group, тикет 06;
 * структура — по просьбе владельца 2026-09-04).
 *
 * Форма одна на все потоки:
 *
 *     <маркер потока> <заголовок события>
 *     <Факт>: <значение>          — ключевые числа и идентификаторы, по строке
 *     …
 *
 *     <тело — по предложению на строку>
 *
 *     Что делать: <действие>
 *     <ссылка на экран панели>
 *
 * Заголовок с маркером — чтобы отличать сообщения в ленте не читая (в корне
 * группы и в личке маркер ещё и говорит, авария это или «к сведению»); факты
 * отдельными строками — чтобы сумму и номер заказа не искать глазами в абзаце;
 * ссылка на своей строке — Telegram делает её кликабельной целиком, а
 * приклеенная к тексту читалась хуже. Информационные сообщения («к сведению»)
 * хвоста не получают: действие у них не придумывается, а пустая строка «Что
 * делать» приучала бы её пропускать.
 *
 * Ссылка — голым URL с хоста ПАНЕЛИ (`PANEL_HOST`), без разметки: группа и
 * личка получают plain text (разметки нет намеренно — тело может нести текст
 * клиента, и экранировать его в каждой точке вызова значило бы однажды забыть),
 * а публичный домен на `/admin` отдаёт 404 (host-гейт `lib/panel/host.ts`) —
 * `APP_URL` дал бы мёртвую ссылку. Без хоста — относительный путь: он хуже
 * кликабельной ссылки, но лучше пустого места (dev-стенд без панели).
 *
 * Чистая функция без env: хост передаёт вызывающий (`notifyOps`, `notifyStaff`).
 */

export type OpsAction = {
  /** Что сделать — короткий инфинитив: «разобрать вручную», «ответить клиенту». */
  text: string;
  /** Относительный путь экрана панели (`/admin/holds`, `/admin/orders/<shortId>`). */
  path?: string;
};

export type OpsFact = {
  /** Метка факта: «Заказ», «Сумма», «Операция». */
  label: string;
  /** Значение как есть — число уже отформатировано вызывающим. */
  value: string;
};

/** Что вызывающий добавляет к телу. Общее для `notifyOps` и `notifyStaff`. */
export type OpsMessageOptions = {
  /** Заголовок события — первая строка сообщения (с маркером потока). */
  title?: string;
  /** Ключевые факты строками сразу под заголовком. */
  facts?: readonly OpsFact[];
  /** «Что делать» — последняя строка, с ссылкой на экран панели, где он есть. */
  action?: OpsAction;
  /**
   * Тело уже свёрстано (обращение клиента с полями и переносами) — не
   * переразбивать по предложениям.
   */
  preformatted?: boolean;
};

export type OpsMessage = OpsMessageOptions & {
  /** Поток — даёт маркер заголовка. Без потока маркера нет. */
  stream?: AlertStream;
  /** Тело как есть. */
  body: string;
};

/** Абсолютная ссылка на экран панели; без хоста — сам путь. */
export function panelUrl(path: string, panelHost: string | null | undefined): string {
  const host = panelHost?.trim();
  return host ? `https://${host}${path}` : path;
}

/**
 * Предложение на строку. Граница — знак конца предложения (или закрывающая
 * кавычка/скобка после него) и пробел перед заглавной буквой или «: так не
 * рвутся «3 250.00 ₽», «T+1» и «docs/incidents.md», а «Нужен ручной разбор.»
 * получает свою строку.
 */
export function splitSentences(text: string): string {
  return text.replace(/([.!?…][»)]?)\s+(?=[А-ЯЁA-Z«(])/gu, '$1\n');
}

export function formatOpsMessage(message: OpsMessage, panelHost: string | null | undefined): string {
  const blocks: string[] = [];

  const head: string[] = [];
  const title = message.title?.trim();
  if (title) {
    const marker = message.stream ? `${STREAM_MARKERS[message.stream]} ` : '';
    head.push(`${marker}${title}`);
  }
  for (const fact of message.facts ?? []) head.push(`${fact.label}: ${fact.value}`);
  if (head.length > 0) blocks.push(head.join('\n'));

  blocks.push(message.preformatted ? message.body : splitSentences(message.body));

  if (message.action) {
    const tail = [`Что делать: ${message.action.text}`];
    if (message.action.path) tail.push(panelUrl(message.action.path, panelHost));
    blocks.push(tail.join('\n'));
  }
  return blocks.join('\n\n');
}
