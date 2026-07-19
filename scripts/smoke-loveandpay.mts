/**
 * УСТАРЕЛО (L-17, 2026-07-19): с включения IP-allowlist L&P (2026-07-16) запросы
 * должны идти через CONNECT-прокси (LOVEANDPAY_PROXY_URL) — этот скрипт бьёт
 * напрямую и с локальной машины получит DOMAIN_NOT_VERIFIED/SOURCE_IP_NOT_ALLOWED.
 * Оставлен как справка по подписи; для живой проверки используйте прод-логи
 * или healthcheck прокси (lib/jobs/proxy-health.ts).
 */
/**
 * Smoke-проверка интеграции Love & Pay.
 *
 * Запуск:
 *   npx tsx --env-file=.env scripts/smoke-loveandpay.mts
 *
 * Делает один безопасный GET /api/v2/rates?base=USDT&quote=RUB.
 * Ничего не создаёт, реальных денег не двигает.
 */
import { createHash, createHmac } from 'node:crypto';

const apiKey = process.env.LOVEANDPAY_API_KEY;
const secretKey = process.env.LOVEANDPAY_SECRET_KEY;
const baseUrl = process.env.LOVEANDPAY_BASE_URL ?? 'https://loveandpay.io/api/v2';

if (!apiKey || !secretKey) {
  console.error('❌ Не заданы LOVEANDPAY_API_KEY / LOVEANDPAY_SECRET_KEY');
  process.exit(1);
}

const u = new URL(baseUrl);
const origin = `${u.protocol}//${u.host}`;
const apiPath = u.pathname.replace(/\/$/, '');

const signPath = `${apiPath}/rates`;
const query = 'base=USDT&quote=RUB';
const method = 'GET';
const body = '';
const timestamp = Date.now().toString();

const bodyHash = createHash('sha256').update(body).digest('hex');
const message = `${method}${signPath}${timestamp}${bodyHash}`;
const signature = createHmac('sha256', secretKey).update(message).digest('hex');

const url = `${origin}${signPath}?${query}`;

console.log('→ Request:');
console.log('  URL       :', url);
console.log('  Method    :', method);
console.log('  signPath  :', signPath);
console.log('  timestamp :', timestamp);
console.log('  bodyHash  :', bodyHash);
console.log('  apiKey    :', apiKey.slice(0, 10) + '...' + apiKey.slice(-4));
console.log('  signature :', signature.slice(0, 16) + '...');
console.log('');

const startedAt = Date.now();

try {
  const resp = await fetch(url, {
    method,
    headers: {
      'x-api-key': apiKey,
      'x-timestamp': timestamp,
      'x-signature': signature,
    },
  });

  const durationMs = Date.now() - startedAt;
  const text = await resp.text();

  console.log(`← Response (${resp.status} in ${durationMs}ms):`);
  console.log('  Headers:');
  for (const [k, v] of resp.headers.entries()) {
    if (k.toLowerCase().includes('rate-limit') || k.toLowerCase() === 'x-request-id') {
      console.log(`    ${k}: ${v}`);
    }
  }
  console.log('  Body:');
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    console.log('    (non-JSON)', text.slice(0, 500));
  }

  if (resp.ok) {
    console.log('');
    console.log('✅ HMAC работает. Курс получен — интеграция жива.');
  } else {
    console.log('');
    console.log('❌ HTTP ' + resp.status);
    if (resp.status === 401) {
      console.log('   Скорее всего INVALID_SIGNATURE или MISSING_HEADERS.');
      console.log('   Возможные причины:');
      console.log('   - API_KEY без префикса pk_test_/pk_live_ — попробовать с префиксом.');
      console.log('   - SECRET_KEY неверный.');
      console.log('   - Часы машины сильно расходятся со временем сервера.');
    }
  }
} catch (err) {
  console.error('❌ Network error:', err);
  process.exit(2);
}
