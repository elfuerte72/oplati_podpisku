import 'server-only';

import { getDb, nextFreekassaNonce } from '@oplati/db';

import { serverEnv } from '../env.server.ts';
import { childLogger } from '../logger.ts';
import { FreekassaClient } from './client.ts';
import { alertOnFreekassaNonceRejected } from './nonce-alert.ts';

/**
 * Lazy-singleton клиента Freekassa — тот же паттерн, что у `getDb()`,
 * `getLoveAndPayClient()` и `lib/telegram/bot.ts`: на build-time `serverEnv`
 * может быть пуст, поэтому инициализация откладывается до первого вызова.
 */

let _client: FreekassaClient | undefined;

/**
 * Настроен ли шлюз. Гейт на старте (`lib/env.ts` → superRefine) требует ключи
 * только когда Freekassa выбрана основной; этот предикат нужен местам, которые
 * работают независимо от переключателя (вебхук).
 */
export function isFreekassaConfigured(): boolean {
  return Boolean(
    serverEnv.FREEKASSA_API_KEY &&
      serverEnv.FREEKASSA_SHOP_ID &&
      serverEnv.FREEKASSA_SECRET_WORD_2,
  );
}

export function getFreekassaClient(): FreekassaClient {
  if (_client) return _client;

  const apiKey = serverEnv.FREEKASSA_API_KEY;
  const shopId = serverEnv.FREEKASSA_SHOP_ID;

  if (!apiKey || !shopId) {
    throw new Error('FREEKASSA_API_KEY / FREEKASSA_SHOP_ID не заданы в env');
  }

  _client = new FreekassaClient({
    apiKey,
    shopId,
    baseUrl: serverEnv.FREEKASSA_BASE_URL,
    logger: childLogger('freekassa'),
    // Монотонный nonce — последовательность Postgres (миграция 0026).
    nonceProvider: () => nextFreekassaNonce(getDb()),
    // Fire-and-forget намеренно: ждать Telegram здесь значит держать очередь
    // запросов к Freekassa (`serialized`) на время отправки DM — при отказе по
    // nonce она и так падает у всех подряд. `.catch` обязателен (репо-паттерн
    // `analytics/track.ts`, `telegram/send.ts`): Node 24 роняет ПРОЦЕСС на
    // необработанном отклонении — проверено на прод-контейнере, — и сбой
    // алёрта убивал бы приложение ровно в момент аварии приёма оплаты.
    onApiError: (err, ctx) => {
      void alertOnFreekassaNonceRejected(err, ctx).catch(() => undefined);
    },
  });
  return _client;
}

export { FreekassaClient } from './client.ts';
export { FreekassaApiError, FreekassaContractError } from './errors.ts';
export { isFreekassaUnavailable } from './availability.ts';
export {
  buildSignaturePayload,
  expectedNotificationSignature,
  signApiRequest,
  verifyNotificationSignature,
} from './sign.ts';
