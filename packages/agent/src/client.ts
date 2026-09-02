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

/** Endpoint DeepSeek, совместимый с Anthropic Messages API. */
export const SUPPORT_AI_DEFAULT_BASE_URL = 'https://api.deepseek.com/anthropic';

/** Модель помощника по умолчанию. */
export const SUPPORT_AI_DEFAULT_MODEL = 'deepseek-v4-flash';

let _supportClient: Anthropic | undefined;

/**
 * Настроен ли помощник — есть ли ключ.
 *
 * Отдельная проверка, а не `try { getSupportClient() }`: включённый флаг без
 * ключа обязан вести себя КАК ВЫКЛЮЧЕННЫЙ (клиент идёт к человеку), а не
 * ронять обработчик исключением. Вызывающий обязан спросить это ПЕРЕД
 * `getSupportClient()` — тот бросает намеренно, чтобы «забыли проверить» не
 * превращалось в запрос к провайдеру с пустым ключом.
 */
export function isSupportAiConfigured(): boolean {
  // `Boolean()` — `KEY=` в env это «не задано», а не пустой ключ.
  return Boolean(process.env.SUPPORT_AI_API_KEY);
}

/**
 * Клиент помощника поддержки — ОТДЕЛЬНЫЙ экземпляр SDK с другим `baseURL` и
 * другим ключом.
 *
 * Общие `ANTHROPIC_*` не трогаются намеренно: продажный агент и Haiku-роутер
 * остаются на Anthropic, и авария у одного провайдера не должна гасить второго.
 * Ретраев два и таймаут 20 с — ход поддержки синхронный, клиент ждёт ответа в
 * чате, и минутное ожидание для него неотличимо от молчания.
 */
export function getSupportClient(): Anthropic {
  if (_supportClient) return _supportClient;
  // `||`, а не `??`: `KEY=` в env — это «не задано», а не пустой ключ.
  const apiKey = process.env.SUPPORT_AI_API_KEY;
  if (!apiKey) throw new Error('SUPPORT_AI_API_KEY is not set');
  _supportClient = new Anthropic({
    apiKey,
    baseURL: process.env.SUPPORT_AI_BASE_URL || SUPPORT_AI_DEFAULT_BASE_URL,
    timeout: 20_000,
    maxRetries: 2,
  });
  return _supportClient;
}

let _panelAnalystClient: Anthropic | undefined;

/**
 * Клиент AI-аналитика панели — тот же провайдер и ключ, что у помощника, но
 * СВОЙ экземпляр SDK с другими сроками.
 *
 * У помощника 20 с и два ретрая рассчитаны на короткую реплику клиенту в чате.
 * Аналитик отдаёт до 2000 токенов НЕ потоком: заголовки ответа приходят только
 * после генерации, поэтому здоровый ответ на 20-30 с помощниковый таймер
 * обрывал бы и пересылал запрос дважды — сотрудник ждал бы минуту и получал
 * «модель не ответила», а провайдер брал бы деньги за три входа
 * (code-review 2026-09-02). Ретрай один: ход стоит денег, а сотрудник видит
 * отказ и повторяет сам.
 */
export function getPanelAnalystClient(): Anthropic {
  if (_panelAnalystClient) return _panelAnalystClient;
  const apiKey = process.env.SUPPORT_AI_API_KEY;
  if (!apiKey) throw new Error('SUPPORT_AI_API_KEY is not set');
  _panelAnalystClient = new Anthropic({
    apiKey,
    baseURL: process.env.SUPPORT_AI_BASE_URL || SUPPORT_AI_DEFAULT_BASE_URL,
    timeout: 90_000,
    maxRetries: 1,
  });
  return _panelAnalystClient;
}

/**
 * Имя модели помощника.
 *
 * ⚠️ Незнакомый id DeepSeek молча маппит на flash — ответ провайдера обязан
 * подтверждать `model`, иначе опечатка в env выглядит как рабочая настройка
 * (смоук-скрипт `scripts/support-smoke.ts` это и печатает).
 */
export function supportModel(): string {
  return process.env.SUPPORT_AI_MODEL || SUPPORT_AI_DEFAULT_MODEL;
}
