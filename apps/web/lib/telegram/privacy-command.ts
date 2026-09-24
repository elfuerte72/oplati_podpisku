import 'server-only';

import { siteUrl } from '../deployment-url.ts';
import { childLogger } from '../logger.ts';
import { sendSafely } from './send.ts';

const log = childLogger('telegram.privacy');

/**
 * `/privacy` — ссылки на политику конфиденциальности и соглашение.
 *
 * Требование Telegram к ботам: политика должна быть доступна командой
 * `/privacy` (канал @BotNews), а работа без собственной политики грозит
 * приостановкой бота. До 2026-09-24 команда падала в общую подсказку «в
 * переписке я не отвечаю» — политику из чата было не найти.
 *
 * Документы — страницы сайта (`siteUrl()`: на проде `www.oplatishka.com`),
 * второго текста нет. В `messages` ответ не пишется: бот держит «чего ждёт
 * от клиента» в meta последней своей реплики (`readPendingMeta`), и справка
 * посреди начатого флоу поддержки затёрла бы его.
 */
export function isPrivacyCommand(text: string): boolean {
  return text === '/privacy' || text.startsWith('/privacy ') || text.startsWith('/privacy@');
}

export function privacyCommandText(): string {
  const site = siteUrl().replace(/\/$/, '');
  return [
    'Документы Оплатишки:',
    `Политика конфиденциальности — ${site}/privacy`,
    `Пользовательское соглашение — ${site}/terms`,
  ].join('\n');
}

export async function handlePrivacyCommand(chatId: number, updateId: number): Promise<void> {
  const delivered = await sendSafely(chatId, privacyCommandText(), updateId);
  log.info({ event: 'telegram.privacy_command', updateId, delivered });
}
