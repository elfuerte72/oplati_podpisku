/**
 * Единый шаблон уведомления персоналу и владельцу (трек ops-group, тикет 06).
 *
 * Форма одна на все потоки:
 *
 *     <заголовок события>
 *
 *     <тело — текущий текст, без переписывания>
 *
 *     Что делать: <действие> <ссылка на экран панели>
 *
 * Заголовок — чтобы отличать сообщения в ленте темы не читая; хвост — чтобы
 * не вспоминать, куда идти. Информационные сообщения («к сведению») хвоста не
 * получают: действие у них не придумывается, а пустая строка «Что делать»
 * приучала бы её пропускать.
 *
 * Ссылка — голым URL с хоста ПАНЕЛИ (`PANEL_HOST`), без разметки: группа и
 * личка получают plain text, а публичный домен на `/admin` отдаёт 404
 * (host-гейт `lib/panel/host.ts`) — `APP_URL` дал бы мёртвую ссылку. Без
 * хоста — относительный путь: он хуже кликабельной ссылки, но лучше пустого
 * места (dev-стенд без панели).
 *
 * Чистая функция без env: хост передаёт вызывающий (`notifyOps`, `notifyStaff`).
 */

export type OpsAction = {
  /** Что сделать — короткий инфинитив: «разобрать вручную», «ответить клиенту». */
  text: string;
  /** Относительный путь экрана панели (`/admin/holds`, `/admin/orders/<shortId>`). */
  path?: string;
};

/** Что вызывающий добавляет к телу: заголовок и «Что делать». Общее для `notifyOps` и `notifyStaff`. */
export type OpsMessageOptions = {
  /** Заголовок события — первая строка сообщения. */
  title?: string;
  /** «Что делать» — последняя строка, с ссылкой на экран панели, где он есть. */
  action?: OpsAction;
};

export type OpsMessage = OpsMessageOptions & {
  /** Тело как есть. */
  body: string;
};

/** Абсолютная ссылка на экран панели; без хоста — сам путь. */
export function panelUrl(path: string, panelHost: string | null | undefined): string {
  const host = panelHost?.trim();
  return host ? `https://${host}${path}` : path;
}

export function formatOpsMessage(message: OpsMessage, panelHost: string | null | undefined): string {
  const parts: string[] = [];
  const title = message.title?.trim();
  if (title) parts.push(title);
  parts.push(message.body);
  if (message.action) {
    const link = message.action.path ? ` ${panelUrl(message.action.path, panelHost)}` : '';
    parts.push(`Что делать: ${message.action.text}${link}`);
  }
  return parts.join('\n\n');
}
