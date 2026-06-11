import Anthropic from '@anthropic-ai/sdk';

/**
 * Singleton Anthropic-клиента — общий для основного агента (index.ts)
 * и Haiku-роутера (router.ts). Вынесен в отдельный модуль, чтобы router
 * не импортировал index (и наоборот) — без циклов между модулями пакета.
 */

let _client: Anthropic | undefined;

export function getClient(): Anthropic {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  _client = new Anthropic({ apiKey });
  return _client;
}
