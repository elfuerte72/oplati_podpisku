import { smmConfig, type SmmConfig } from '../config/smm.config.ts';

/**
 * Web Intent Threads: адрес, который на телефоне открывает приложение с
 * готовым текстом. Контракт снят с документации Meta (ресерч 15.09.2026):
 * домен `threads.com` (threads.net редиректит), параметры `text` и `tag`,
 * всё percent-encoded.
 *
 * ⚠️ Параметр `url` НЕ используется: на Android он теряется при переходе в
 * приложение, поэтому ссылка идёт текстом в последний ответ цепочки.
 *
 * Модуль отдельный, потому что адрес нужен ДВУМ сторонам: линт проверяет, что
 * пост в него влезает, а рендер ставит его в кнопку. Две реализации разошлись
 * бы, и линт разрешал бы то, что кнопка уже не передаёт.
 */
export function threadsIntentUrl(
  text: string,
  tag?: string,
  config: SmmConfig = smmConfig,
): string {
  const params = new URLSearchParams();
  params.set('text', text);
  if (tag !== undefined && tag !== '') params.set('tag', tag);
  // URLSearchParams кодирует пробел как `+`, а Threads показал бы плюс
  // буквально: заменяем на %20, как это делал прежний контур.
  return `${config.threads.intentBase}?${params.toString().replace(/\+/g, '%20')}`;
}
