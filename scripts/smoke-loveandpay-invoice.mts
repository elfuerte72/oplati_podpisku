/**
 * Smoke: создание invoice через POST /api/v2/invoices.
 *
 * Запуск:
 *   npx tsx --env-file=.env scripts/smoke-loveandpay-invoice.mts
 *
 * Создаёт счёт на 1₽ с TTL=1ч. Реальной оплаты не делает.
 * Через час счёт сам экспайрится — следов не оставит.
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

const signPath = `${apiPath}/invoices`;
const method = 'POST';
/*
 * Email клиента берётся из env SMOKE_CUSTOMER_EMAIL. Если не задан — поле опущено
 * (L&P может вернуть VALIDATION_ERROR). Email должен быть реальный (антифрод
 * отклоняет example.com и подобные тестовые домены).
 */
const customerEmail = process.env.SMOKE_CUSTOMER_EMAIL;
const body = JSON.stringify({
  amount: 100,
  currency: 'RUB',
  description: 'smoke test',
  ...(customerEmail ? { customerEmail } : {}),
  customerName: 'Smoke Test',
  expiresInHours: 1,
  paymentMethod: 'card',
});

const timestamp = Date.now().toString();
const bodyHash = createHash('sha256').update(body).digest('hex');
const message = `${method}${signPath}${timestamp}${bodyHash}`;
const signature = createHmac('sha256', secretKey).update(message).digest('hex');

const url = `${origin}${signPath}`;

console.log('→ Request:');
console.log('  URL       :', url);
console.log('  Method    :', method);
console.log('  signPath  :', signPath);
console.log('  timestamp :', timestamp);
console.log('  body      :', body);
console.log('  signature :', signature.slice(0, 16) + '...');
console.log('');

const startedAt = Date.now();

try {
  const resp = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'x-timestamp': timestamp,
      'x-signature': signature,
    },
    body,
  });

  const durationMs = Date.now() - startedAt;
  const text = await resp.text();

  console.log(`← Response (${resp.status} in ${durationMs}ms):`);
  for (const [k, v] of resp.headers.entries()) {
    if (k.toLowerCase().includes('rate-limit') || k.toLowerCase() === 'x-request-id') {
      console.log(`    ${k}: ${v}`);
    }
  }
  console.log('  Body:');
  try {
    const parsed = JSON.parse(text) as unknown;
    console.log(JSON.stringify(parsed, null, 2));

    if (resp.ok && typeof parsed === 'object' && parsed !== null && 'invoice' in parsed) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const invoice = (parsed as any).invoice;
      console.log('');
      console.log('✅ Счёт создан!');
      console.log('  ID         :', invoice.id);
      console.log('  Number     :', invoice.invoiceNumber);
      console.log('  Status     :', invoice.status);
      console.log('  paymentLink:', invoice.paymentLink);
      console.log('  expiresAt  :', invoice.expiresAt);
      console.log('  qrPayload  :', invoice.qrPayload ?? '(no SBP QR)');
    }
  } catch {
    console.log('    (non-JSON)', text.slice(0, 500));
  }

  if (!resp.ok) {
    console.log('');
    console.log('❌ HTTP ' + resp.status);
  }
} catch (err) {
  console.error('❌ Network error:', err);
  process.exit(2);
}
