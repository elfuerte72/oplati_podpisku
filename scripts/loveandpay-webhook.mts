/**
 * Управление webhook'ами Love & Pay через API v2.
 *
 * Подпись — тот же HMAC v2, что в apps/web/lib/loveandpay/sign.ts:
 *   signature = HMAC-SHA256(secretKey, METHOD + FULL_PATH + TIMESTAMP_ms + SHA256(body)) -> hex
 * В подпись идёт ПОЛНЫЙ path с /api/v2 (иначе INVALID_SIGNATURE). Query в подпись не входит.
 *
 * ВНИМАНИЕ: endpoint `/api/v2/webhooks` и тело { url, events } взяты из
 * docs/runbook-mvp.md — публичные доки L&P недоступны, контракт НЕ подтверждён.
 * Поэтому сначала запусти `list` (read-only GET): если вернётся 200 с осмысленным
 * телом — контракт верен; если 404 — у L&P другой путь либо только UI в кабинете.
 *
 * Ключи берутся из env (НЕ коммить их). Запуск:
 *   LOVEANDPAY_API_KEY=pk_test_... LOVEANDPAY_SECRET_KEY=sk_test_... \
 *     npx tsx scripts/loveandpay-webhook.mts list
 *
 *   LOVEANDPAY_API_KEY=... LOVEANDPAY_SECRET_KEY=... \
 *     npx tsx scripts/loveandpay-webhook.mts create \
 *       https://oplati-podpisku-web-git-dev-penkinjr-gmailcoms-projects.vercel.app/api/payments/loveandpay
 *
 *   ... npx tsx scripts/loveandpay-webhook.mts delete <webhookId>
 */
import { createHash, createHmac } from 'node:crypto';

const apiKey = process.env.LOVEANDPAY_API_KEY;
const secretKey = process.env.LOVEANDPAY_SECRET_KEY;
const baseUrl = process.env.LOVEANDPAY_BASE_URL ?? 'https://loveandpay.io/api/v2';

if (!apiKey || !secretKey) {
  console.error('Не заданы LOVEANDPAY_API_KEY / LOVEANDPAY_SECRET_KEY в env.');
  process.exit(1);
}

const [, , command, arg] = process.argv;

const DEFAULT_EVENTS = ['invoice.paid', 'invoice.expired', 'invoice.cancelled'];

const u = new URL(baseUrl);
const origin = `${u.protocol}//${u.host}`;
const apiPath = u.pathname.replace(/\/$/, ''); // '/api/v2'

type Method = 'GET' | 'POST' | 'DELETE';

function sign(method: Method, signPath: string, body: string) {
  const timestamp = Date.now().toString();
  const bodyHash = createHash('sha256').update(body).digest('hex');
  const message = `${method}${signPath}${timestamp}${bodyHash}`;
  const signature = createHmac('sha256', secretKey!).update(message).digest('hex');
  return { timestamp, signature };
}

async function call(method: Method, path: string, body: string | null): Promise<void> {
  const signPath = `${apiPath}${path}`;
  const bodyText = body ?? '';
  const { timestamp, signature } = sign(method, signPath, bodyText);
  const url = `${origin}${signPath}`;

  console.log(`-> ${method} ${url}`);
  if (body) console.log('   body:', body);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30_000);
  let resp: Response;
  try {
    resp = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey!,
        'x-timestamp': timestamp,
        'x-signature': signature,
      },
      body: method === 'GET' ? undefined : bodyText,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  const text = await resp.text();
  console.log(`<- ${resp.status} ${resp.statusText}`);
  const reqId = resp.headers.get('x-request-id');
  if (reqId) console.log('   x-request-id:', reqId);
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    console.log('   (non-JSON):', text.slice(0, 800));
  }

  if (resp.status === 404) {
    console.log('');
    console.log('404: endpoint /api/v2/webhooks не существует у L&P.');
    console.log('Зарегистрируй webhook через UI в кабинете L&P, либо уточни путь у поддержки.');
  }
}

switch (command) {
  case 'list':
    await call('GET', '/webhooks', null);
    break;
  case 'create': {
    if (!arg) {
      console.error('Укажи URL: ... create <https://.../api/payments/loveandpay>');
      process.exit(1);
    }
    await call('POST', '/webhooks', JSON.stringify({ url: arg, events: DEFAULT_EVENTS }));
    console.log('');
    console.log('Если в ответе есть секрет (whsec_*) — положи его в Vercel env');
    console.log('LOVEANDPAY_WEBHOOK_SECRET (Preview) и сделай redeploy.');
    break;
  }
  case 'delete': {
    if (!arg) {
      console.error('Укажи id: ... delete <webhookId>');
      process.exit(1);
    }
    await call('DELETE', `/webhooks/${encodeURIComponent(arg)}`, null);
    break;
  }
  default:
    console.error('Команды: list | create <url> | delete <id>');
    process.exit(1);
}
