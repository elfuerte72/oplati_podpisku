import { ProxyAgent, fetch as undiciFetch } from 'undici';

/**
 * fetch-обёртка, гоняющая запросы через HTTP CONNECT-прокси (undici ProxyAgent).
 *
 * Зачем: L&P принимает API-запросы только с задекларированных IP, а egress
 * Vercel-функций динамический. Прокси на VPS с фиксированным IP решает это без
 * Vercel Static IPs. TLS устанавливается насквозь (CONNECT) — прокси не видит
 * ни HMAC-подпись, ни API-ключи.
 *
 * Прокси-URL содержит credentials — никогда не логировать целиком.
 */
export function buildProxyFetch(proxyUrl: string): typeof fetch {
  const dispatcher = new ProxyAgent(proxyUrl);
  // undici.fetch типово несовместим с lib.dom `typeof fetch` (свои Request/Response),
  // но в Node runtime глобальный fetch — это и есть undici, структурно они идентичны.
  return ((input: Parameters<typeof undiciFetch>[0], init?: Parameters<typeof undiciFetch>[1]) =>
    undiciFetch(input, { ...init, dispatcher })) as unknown as typeof fetch;
}

/** host:port прокси без credentials — безопасно для логов. */
export function proxyHostForLog(proxyUrl: string): string {
  const u = new URL(proxyUrl);
  return `${u.hostname}:${u.port}`;
}
